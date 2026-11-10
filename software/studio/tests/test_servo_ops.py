"""舵机页的操作（servo_ops，照搬 servo-web）：用协议级模拟舵机跑一遍。"""
import itertools
import json
import os
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE.parent), str(HERE.parent / "deps")]

from studio.log import Log  # noqa: E402
from studio.servo import ServoSession  # noqa: E402
from studio.commit import load_centered, record_centered  # noqa: E402
from studio.servo_ops import SIM_WIGGLE, Refused  # noqa: E402


class ServoOpsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.s = ServoSession(Log(Path(self.tmp.name) / "logs", echo=False, background=False), sim=True,
                              state_dir=self.tmp.name)
        ok, why = self.s.open("测试")
        self.assertTrue(ok, why)
        end = time.monotonic() + 2
        while len(self.s.rows) < 15 and time.monotonic() < end:
            time.sleep(0.02)
        self.o = self.s.ops

    def tearDown(self):
        self.s.close()
        self.tmp.cleanup()

    def sim(self, i):
        return self.s.sim_serial.servos[i]

    def test_torque_on_aligns_goal_first(self):
        r = self.o.handle({"op": "torque", "on": 1, "ids": [22]})
        self.assertEqual(r["on"], [22])
        self.assertEqual(self.sim(22).r[40], 1)
        self.assertEqual(round(self.sim(22).pos()), 2347)          # 没冲：目标先对准了当前位置

    def test_slider_goal_moves_when_holding(self):
        self.o.handle({"op": "torque", "on": 1, "ids": [20]})
        self.o.handle({"op": "goal", "id": 20, "pos": 2300})
        self.assertEqual(round(self.sim(20).pos()), 2300)

    def test_calibrate_sets_2048_and_holds(self):
        plan = self.o.handle({"op": "calib_plan", "ids": "22"})
        self.assertAlmostEqual(plan["rows"][0]["diff_deg"], -26.3, delta=0.1)
        r = self.o.handle({"op": "calibrate", "ids": "22"})
        self.assertEqual(r["ok"], [22])
        self.assertEqual(round(self.sim(22).pos()), 2048)
        self.assertEqual(self.sim(22).r[40], 1)                     # 用户要求：校完马上保持
        self.assertEqual(r["hold"]["on"], [22])
        u = self.o.handle({"op": "undo"})
        self.assertEqual(u["ok"], [22])
        self.assertEqual(round(self.sim(22).pos()), 2347)          # 撤销回原来的偏移

    def test_calibrate_with_torque_on_and_minus_offset_does_not_double_the_error(self):
        """10-19 二号鸭 #24：扭矩开着校，偏移符号探针探不出（舵机顶回目标、读数不动），以前默认按「+」补下垂，
        HD-1910 实际是「读数 = 原始 − 偏移」→ 误差翻倍（16→32、43→86、87→174 步）。现在从这次 0x0B 反推方向。"""
        for droop in (0.0, 0.5):
            with self.subTest(droop=droop):
                self.o.offset_sign = None
                sv = self.sim(22)
                sv.offset_adds = False
                sv.droop = droop
                self.o.handle({"op": "torque", "on": 1, "ids": [22]})
                self.o.handle({"op": "goal", "id": 22, "pos": 2120})      # 摆到离零位 72 步的地方
                phys = sv.phys                                   # 用户摆好的位置（扭矩开着顶在这里）
                r = self.o.handle({"op": "calibrate", "ids": "22"})
                self.assertEqual(r["ok"], [22])
                self.assertEqual(self.o.offset_sign, -1)         # 反推出来了
                at_phys = phys - sv.off                          # 摆好的那个位置现在读多少
                self.assertLessEqual(abs(at_phys - 2048), 3, f"摆好的位置读 {at_phys}，不是 2048")
                sv.droop = 0.0

    def test_infer_offset_sign(self):
        from studio.servo_ops import infer_offset_sign
        self.assertEqual(infer_offset_sign(2064, 2048, 16), -1)      # #24 第一次：读数降 16、偏移加 16
        self.assertEqual(infer_offset_sign(2064, 2048, -16), 1)
        self.assertEqual(infer_offset_sign(2064, 2046, 16), -1)      # 中间又垂了 2 步也认得
        self.assertIsNone(infer_offset_sign(2050, 2048, 2))          # 变得太少，分不清
        self.assertIsNone(infer_offset_sign(2100, 2048, 16))         # 两个方向都对不上

    def test_latched_refuses_motion_until_manual_torque_on(self):
        """卸力以后：拖滑块、走姿势、校准都被拒绝；人自己点「扭矩开 / 保持」就算解除（用户不想再点「解除锁定」）。"""
        self.assertTrue(self.s.relax_all("测试")[0])
        for args in ({"op": "goal", "id": 20, "pos": 2100}, {"op": "calibrate", "ids": "20"},
                     {"op": "official", "key": "stand"}, {"op": "idle", "on": True}):
            with self.assertRaises(Refused):
                self.o.handle(args)
        self.assertEqual(self.o.handle({"op": "torque", "on": 1, "ids": [20]})["on"], [20])
        self.assertFalse(self.s.latched)
        self.o.handle({"op": "goal", "id": 20, "pos": 2100})

    def test_official_pose_and_saved_poses(self):
        self.o.handle({"op": "torque", "on": 1})
        self.o.handle({"op": "official", "key": "zero", "seconds": 0.2, "mode": "stream"})
        time.sleep(0.8)
        self.assertEqual(round(self.sim(22).pos()), 2048)
        poses = self.o.handle({"op": "save_pose", "name": "零位存档"})["poses"]
        self.assertEqual(poses[0]["name"], "零位存档")
        self.assertEqual(self.o.handle({"op": "delete_pose", "file": poses[0]["file"]})["poses"], [])

    def test_tools(self):
        self.assertEqual(self.o.handle({"op": "scan", "ids": "20-24"})["found"], [20, 21, 22, 23, 24])
        self.assertEqual(len(self.o.handle({"op": "dump", "id": 20})["rows"]), 62)    # 含 HD-1910 运行中的 P/D/I（50–52）
        self.assertEqual(self.o.handle({"op": "timing", "n": 10})["fails"], 0)
        with self.assertRaises(Refused):
            self.o.handle({"op": "write_reg", "id": 20, "addr": 40, "value": 1})   # 扭矩开关不让从这里写
        with self.assertRaises(Refused):
            self.o.handle({"op": "nope"})

    # ---- 零位微调、读数晃动 ----

    def test_zero_jog_then_set_moves_the_zero_not_the_joint(self):
        """点动对准 →「设为零位」：只换算偏移，关节不动，这个位置读 2048；存的姿态跟着挪；
        「撤销上一次」一次撤回整轮，零位微调之前就校过中位的记录不删。"""
        self.o.handle({"op": "calibrate", "ids": "22"})            # 先中位校准：2048 保持住，偏移方向也知道了
        self.s.sim = False                                           # 走真机那条路：存的姿态要跟着挪（模拟模式不挪）
        record_centered(self.tmp.name, [22], "测试")
        sv = self.sim(22)
        self.o.handle({"op": "save_pose", "name": "存档"})
        off0 = sv.off
        for _ in range(3):
            self.o.handle({"op": "zero_jog", "id": 22, "step": 5})
        self.assertEqual(round(sv.pos()), 2063)
        phys = sv.phys
        st = self.o.handle({"op": "zero_set", "id": 22})["servos"]["22"]
        self.assertAlmostEqual(sv.phys, phys, delta=0.5)             # 关节没动
        self.assertEqual(round(sv.pos()), 2048)                      # 对准的位置现在读 2048
        self.assertEqual(sv.off - off0, -15)                        # 读数 = 原始 + 偏移：Δ偏移 = 2048 − 2063
        self.assertEqual(st["changed"], -15)
        self.assertEqual(self.o.list_poses()[0]["goals"][22], 2048 - 15)   # 原来的零位现在读 2033
        u = self.o.handle({"op": "undo"})
        self.assertEqual(u["ok"], [22])                              # 只碰这一轮改过的那颗
        self.assertEqual(sv.off, off0)
        self.assertEqual(self.o.list_poses()[0]["goals"][22], 2048)
        self.assertIn(22, load_centered(self.tmp.name))

    def test_zero_set_with_minus_offset_sign(self):
        """HD-1910 是「读数 = 原始 − 偏移」：方向弄反的话关节会被拉走两倍那么多。"""
        sv = self.sim(22)
        sv.offset_adds = False
        self.o.offset_sign = None
        self.o.handle({"op": "calibrate", "ids": "22"})
        self.assertEqual(self.o.offset_sign, -1)
        self.o.handle({"op": "zero_jog", "id": 22, "step": -7})
        phys = sv.phys
        self.o.handle({"op": "zero_set", "id": 22})
        self.assertAlmostEqual(sv.phys, phys, delta=0.5)
        self.assertEqual(round(sv.pos()), 2048)

    def test_offset_sign_is_remembered(self):
        """偏移方向：全部上着力时在 32 上松几毫秒探一步（探完 32 照样保持）并存盘；Studio 重启（内存里没了）用存的；
        没存过、32 也松不了就拒绝，并说清楚怎么办。"""
        self.o.handle({"op": "calibrate", "ids": "22"})
        sign = self.o.offset_sign
        self.o.handle({"op": "torque", "on": 1})
        self.o.offset_sign = None
        self.assertEqual(self.o.ensure_offset_sign(22), sign)
        self.assertEqual(self.sim(32).r[40], 1)                     # 探完 32 又保持住了
        sign_file = os.path.join(self.o.calib_dir(), "offset-sign.json")
        self.assertTrue(os.path.isfile(sign_file))
        self.sim(32).readonly = {40}                                 # 32 松不了：只能用存的
        self.o.offset_sign = None
        self.o.handle({"op": "zero_jog", "id": 22, "step": 3})
        self.o.handle({"op": "zero_set", "id": 22})
        self.assertEqual(self.o.offset_sign, sign)
        os.remove(sign_file)
        self.o.offset_sign = None
        self.o.handle({"op": "zero_jog", "id": 22, "step": 3})
        with self.assertRaises(Refused):
            self.o.handle({"op": "zero_set", "id": 22})

    def test_retired_play_operations_cannot_change_zero(self):
        """旧页面再发记 A/B 或取中时拒绝操作，不能继续修改零位。"""
        self.o.handle({"op": "calibrate", "ids": "23"})
        before = bytes(self.sim(23).r)
        for args in ({"op": "play_mark", "id": 23, "end": "a"},
                     {"op": "play_mark", "id": 23, "end": "b"}, {"op": "play_center", "id": 23}):
            with self.subTest(args=args), self.assertRaisesRegex(Refused, "不认识的指令"):
                self.o.handle(args)
        self.assertEqual(bytes(self.sim(23).r), before)

    def test_zero_ops_need_holding_and_stay_in_range(self):
        with self.assertRaises(Refused):
            self.o.handle({"op": "zero_jog", "id": 20, "step": 1})      # 松着
        self.o.handle({"op": "calibrate", "ids": "20"})
        for _ in range(11):
            self.o.handle({"op": "zero_jog", "id": 20, "step": 10})     # 离 2048 有 110 步
        with self.assertRaises(Refused):
            self.o.handle({"op": "zero_jog", "id": 20, "step": 10})     # 超过 114 步（10°）
        with self.assertRaises(Refused):
            self.o.handle({"op": "zero_revert", "id": 20})              # 这一轮没改过

    def test_zero_revert_one_servo(self):
        """「还原这颗」：偏移改回这一轮开始前的值，关节不动；别的颗不受影响。"""
        self.o.handle({"op": "calibrate", "ids": "21,22"})
        off0 = {i: self.sim(i).off for i in (21, 22)}
        for i in (21, 22):
            self.o.handle({"op": "zero_jog", "id": i, "step": 6})
            self.o.handle({"op": "zero_set", "id": i})
        phys = self.sim(21).phys
        st = self.o.handle({"op": "zero_revert", "id": 21})["servos"]["21"]
        self.assertEqual(self.sim(21).off, off0[21])
        self.assertAlmostEqual(self.sim(21).phys, phys, delta=0.5)
        self.assertEqual(st["changed"], 0)
        self.assertEqual(self.sim(22).off, off0[22] - 6)

    def test_wiggle_and_saved_table(self):
        """表格仅导出实际量过的舵机，零位微调不算测量，不再导出总量或内外间隙。"""
        self.o.handle({"op": "calibrate", "ids": "20"})
        self.o.handle({"op": "zero_jog", "id": 20, "step": 5})
        self.o.handle({"op": "zero_set", "id": 20})
        with self.assertRaisesRegex(Refused, "还没量过"):
            self.o.handle({"op": "play_save"})
        self.o.handle({"op": "torque", "on": 1, "ids": [32]})
        st = self.o.handle({"op": "play_wiggle", "id": 32, "seconds": 1})["servos"]["32"]
        self.assertEqual(st["wiggle"], SIM_WIGGLE[32])
        self.assertTrue({"a", "b", "total", "outside"}.isdisjoint(st))
        out = self.o.handle({"op": "play_save"})
        self.assertEqual([r["id"] for r in out["servos"]], [32])
        self.assertEqual(out["servos"][0]["wiggle_deg"], round(SIM_WIGGLE[32] * 360 / 4096, 2))
        self.assertTrue({"total", "outside", "total_deg", "outside_deg"}.isdisjoint(out["servos"][0]))
        self.assertNotIn("warn_deg", out)
        saved = Path(self.o.calib_dir()) / "servo-play" / out["file"]
        self.assertEqual(json.loads(saved.read_text(encoding="utf-8")), {k: v for k, v in out.items() if k != "file"})

    def test_wiggle_measures_reading_range_without_writing(self):
        """实际测量分支记录读数范围，不改目标、偏移或保持状态；松开时不可测。"""
        with self.assertRaisesRegex(Refused, "没在保持"):
            self.o.handle({"op": "play_wiggle", "id": 32, "seconds": 1})
        self.o.handle({"op": "torque", "on": 1, "ids": [32]})
        self.s.sim = False
        before = bytes(self.sim(32).r)
        with patch.object(self.o, "read_pos", side_effect=itertools.cycle([2048, 2036, 2060, 2050])):
            st = self.o.handle({"op": "play_wiggle", "id": 32, "seconds": 1})["servos"]["32"]
        self.assertEqual(st["wiggle"], 24)
        self.assertEqual(bytes(self.sim(32).r), before)


if __name__ == "__main__":
    unittest.main()
