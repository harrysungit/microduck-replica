// 舞台上的 3D 鸭子。模型就是 servo-web 的 model/（官方 CAD 导出，见 model/NOTICE.md）。
//
// 规矩（review-design-v3 V2、V7）：
// - 表达「现在」：关节角来自状态流，机身按 IMU 的重力方向倾斜；不自转。
// - 能拖着转，转到哪停在哪（用户 10-18：不要自己弹回去）；点「回正」才回默认机位。
// - 点一下舵机就选中它（点击选中、加深，不需要放大）：
//   模型里 15 个 xl330 零件就是 15 颗舵机的外壳。先使用模型的明确绑定，其余按距离一一配上；
//   点到的不是舵机（腿、壳），就选带动这个零件的那颗。按下到松开挪了 6 像素以上算拖动，不算点。
// - 只在有变化时重画：模型 40 多万面，一直按 60 帧画会把笔记本风扇吹起来、手机发烫。
// - 数据旧了由外面给 canvas 加 .stale（去色、半透明），这里不管。
// - 三视图（舵机页用，11-09）：setLayout('quad') 把同一块画布分四格：左上正面、右上侧面（setSide 选哪条腿那一侧）、
//   左下俯视（脸朝下，第一角画法：俯视图在正面图下方；只画腿：从上面看头和身子会把腿全挡住）、右下自由视角。
//   前三格正交投影、同一比例，各带 1 cm / 5 cm 方格（layers 1–3，只在自己那一格看得见），横平竖直一眼看得出来；
//   只有自由那一格能拖着转，点选按点到的那一格算。腿的零件和灯另外放在 layer 7，俯视那格只看 layer 7。
import * as THREE from './vendor/three/three.module.js';
import { OrbitControls } from './vendor/three/addons/OrbitControls.js';
import { RoomEnvironment } from './vendor/three/addons/RoomEnvironment.js';
import { toCreasedNormals } from './vendor/three/addons/BufferGeometryUtils.js';

export const JOINT_NAMES = ['left_hip_yaw', 'left_hip_roll', 'left_hip_pitch', 'left_knee', 'left_ankle',
  'neck_pitch', 'head_pitch', 'head_yaw', 'head_roll', 'mouth',
  'right_hip_yaw', 'right_hip_roll', 'right_hip_pitch', 'right_knee', 'right_ankle'];

const VIEWS = { front34: [-30, 12], back: [180, 12], back34: [205, 14], front: [0, 8] };

function materialFor(rgba) {
  const [r, g, b] = rgba;
  const near = (a, bb, c) => Math.abs(r - a) < 0.04 && Math.abs(g - bb) < 0.04 && Math.abs(b - c) < 0.04;
  let color, rough = 0.5;
  if (near(0.98, 0.71, 0.0)) { color = '#F5B400'; rough = 0.42; }            // 黄色打印件
  else if (near(0.29, 0.29, 0.29)) { color = '#5E6167'; rough = 0.58; }      // 舵机
  else if (near(0.35, 0.38, 0.40)) { color = '#4C5157'; rough = 0.55; }
  else if (near(0.26, 0.28, 0.30)) { color = '#2F3338'; rough = 0.4; }
  else if (near(0.54, 0.85, 0.83)) { color = '#86D3CC'; rough = 0.6; }       // 脚底
  else if (r > 0.75 && g > 0.75 && b > 0.75) { color = '#ECECE8'; rough = 0.5; } // 白壳
  else color = new THREE.Color(r, g, b).getStyle();
  return new THREE.MeshStandardMaterial({ color: new THREE.Color(color), roughness: rough, metalness: 0, envMapIntensity: 0.55 });
}

// 模型解码（量化顶点还原 + 折边法线）在手机上要几百毫秒：整页只做一次，切页面回来直接用。
// 几何体所有 Duck3D 共用，不随某一个 dispose 释放。
let modelCache = null;
// 先在后台线程（model-worker.js）里解码、算折边法线，页面不卡；浏览器不支持 worker 才在主线程里算（老办法）
function loadInWorker(base) {
  return new Promise((resolve, reject) => {
    let w;
    try { w = new Worker(new URL('./model-worker.js', import.meta.url)); } catch (e) { reject(e); return; }
    w.onmessage = (e) => {
      w.terminate();
      if (!e.data.ok) { reject(new Error(e.data.error)); return; }
      const geoms = {};
      for (const [name, m] of Object.entries(e.data.meshes)) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(m.position, 3));
        g.setAttribute('normal', new THREE.BufferAttribute(m.normal, 3));
        if (m.index) g.setIndex(new THREE.BufferAttribute(m.index, 1));
        geoms[name] = g;
      }
      window.__model = { cached: !!e.data.cached, at: performance.now() };   // 排查用：模型什么时候好的、是不是读的缓存
      resolve({ mj: e.data.mj, geoms });
    };
    w.onerror = (e) => { w.terminate(); reject(new Error(e.message || 'worker 出错')); };
    w.postMessage({ base: new URL(base, location.href).href });
  });
}
async function loadModel(base) {
  if (!modelCache) {
    modelCache = loadInWorker(base).catch(() => (async () => {
      const mj = await (await fetch(base + 'model.json', { cache: 'no-cache' })).json();
      const bin = await (await fetch(base + 'meshes.bin')).arrayBuffer();
      const geoms = {};
      for (const [name, m] of Object.entries(mj.meshes)) {
        const q = new Int16Array(bin, m.voff, m.nverts * 3);
        const pos = new Float32Array(m.nverts * 3);
        for (let i = 0; i < m.nverts; i++) for (let k = 0; k < 3; k++) {
          const span = m.bbox_max[k] - m.bbox_min[k] || 1;
          pos[i * 3 + k] = m.bbox_min[k] + (q[i * 3 + k] + 32768) / 65535 * span;
        }
        const idx = m.index_bytes === 2 ? new Uint16Array(bin, m.ioff, m.ntris * 3) : new Uint32Array(bin, m.ioff, m.ntris * 3);
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        g.setIndex(new THREE.BufferAttribute(idx, 1));
        geoms[name] = toCreasedNormals(g, Math.PI / 6);     // 去掉面片感
      }
      return { mj, geoms };
    })()).catch((e) => { modelCache = null; throw e; });
  }
  return modelCache;
}

const same = (a, b, eps) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < eps);

export class Duck3D {
  // pageScroll（总览的舞台用，总览重排审查 O2）：总览是要往下刷的首页，舞台不能把滚轮和手指吃掉——
  // 关掉缩放（滚轮留给页面：OrbitControls 在 enableZoom=false 时不 preventDefault），手机上单指留给页面滚动
  // （canvas 的 touch-action 改回 pan-y，单指不转），两个手指转视角；桌面上鼠标照样拖着转。vendor 里的文件不改，构造以后改设置
  constructor(canvas, { view = 'front34', centerX = 0.61, centerY = 0.5, fill = 0.92, pageScroll = false } = {}) {
    this.canvas = canvas;
    canvas.__duck3d = this;   // 排查用（e2e 也看 frames：不在视口就不画）
    this.frames = 0;          // 真画了几帧
    this.view = view;
    this.centerX = centerX;   // 鸭子水平中心放在画面宽度的哪里（给左边的字让位）
    this.centerY = centerY;   // 竖直方向（手机上字在下面，鸭子往上放）
    this.fill = fill;
    this.joints = {};         // 关节名 -> { pivot, axis }（名字跟 robotd 的 JOINT_NAMES 一致）
    this.layout = 'single';   // 'quad' = 三视图（setLayout）
    this.side = 'left';       // 三视图的侧面看哪一侧
    this.dirty = true;
    this.ready = false;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    // 40 万面按高分屏全分辨率画，转起来会卡、手机会发烫：最多 1.5 倍（用户 10-18：转动缩放有点卡）
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.01, 20);
    this.camera.up.set(0, 0, 1);
    this.trunk = new THREE.Group();    // 按 IMU 倾斜的那一层
    this.content = new THREE.Group();
    this.trunk.add(this.content);
    this.scene.add(this.trunk);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.enablePan = false;
    this.controls.addEventListener('change', () => { this.dirty = true; });
    this.controls.addEventListener('start', () => { this._snapAt = null; this.onUserMove && this.onUserMove(); });
    this.controls.addEventListener('end', () => { if (this._sel) this._seeThrough(); });
    if (pageScroll) {
      this.controls.enableZoom = false;
      this.controls.touches = { ONE: null, TWO: THREE.TOUCH.DOLLY_ROTATE };   // ONE 不是 ROTATE / PAN：单指什么都不做
      canvas.style.touchAction = 'pan-y';          // OrbitControls 构造时设成了 none（OrbitControls.js:36）
    }
    // 不在屏幕上就不画（审查 O9）：停在 #/pad 时舞台滚出去了，每秒 10 次的状态照样让它 dirty；dirty 留着，回来再画
    this._onScreen = true;
    if (typeof IntersectionObserver !== 'undefined') {
      this._io = new IntersectionObserver((es) => { for (const e of es) this._onScreen = e.isIntersecting; if (this._onScreen) this.dirty = true; });
      this._io.observe(canvas);
    }
    // 三视图时只有右下那格（自由）能拖着转：在别的格里按下就先关掉控制器（挂在父元素的捕获阶段，抢在 OrbitControls 前面）
    (canvas.parentElement || canvas).addEventListener('pointerdown', (e) => {
      if (this.layout === 'quad') this.controls.enabled = this._viewAt(e.clientX, e.clientY)?.key === 'free';
    }, true);
    let down = null;
    canvas.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
    canvas.addEventListener('pointerup', (e) => {
      if (!down || !this.onPick || !this.ready) return;
      const moved = Math.hypot(e.clientX - down[0], e.clientY - down[1]);
      down = null;
      if (moved < 6) { const j = this.pick(e.clientX, e.clientY); if (j) this.onPick(j); }
    });
    this.servoOf = {};        // 关节名 -> 那颗舵机的外壳零件
    this._resize = new ResizeObserver(() => this.resize());
    this._resize.observe(canvas);
    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  async load(base = 'model/') {
    const { mj, geoms } = await loadModel(base);
    if (this._dead) return;
    const mjq = (q) => new THREE.Quaternion(q[1], q[2], q[3], q[0]);
    const objs = [];
    const jointOf = [];       // 每个 body 归哪个关节带动（自己有关节就是自己，否则跟父 body）
    const root = mj.bodies.find((b) => b.parent < 0);
    if (root) { this.trunk.position.set(...root.pos); this.content.position.copy(this.trunk.position).negate(); }
    for (const b of mj.bodies) {
      const node = new THREE.Group();
      node.position.set(...b.pos); node.quaternion.copy(mjq(b.quat));
      let inner = node;
      if (b.joint) {
        const pivot = new THREE.Group(); node.add(pivot); inner = pivot;
        this.joints[b.joint.name] = { pivot, axis: new THREE.Vector3(...b.joint.axis).normalize() };
      }
      jointOf.push(b.joint ? b.joint.name : (b.parent >= 0 ? jointOf[b.parent] : null));
      for (const g of b.geoms) {
        const mesh = new THREE.Mesh(geoms[g.mesh], materialFor(g.rgba));
        mesh.userData.jointOf = jointOf[jointOf.length - 1];
        if (/^(left|right)_/.test(mesh.userData.jointOf || '')) mesh.layers.enable(7);   // 腿：三视图的俯视格只画它
        mesh.userData.servo = g.mesh === 'xl330';
        if (mesh.userData.servo && g.servo_joint) mesh.userData.servoJoint = g.servo_joint;
        mesh.position.set(...g.pos); mesh.quaternion.copy(mjq(g.quat)); inner.add(mesh);
      }
      objs.push({ inner });
      if (b.parent < 0) this.content.add(node); else objs[b.parent].inner.add(node);
    }
    this._lights();
    this._mapServos();
    this.ready = true;
    this._frame();
    if (this.layout === 'quad') this._orthoFrame();
    this.dirty = true;
  }

  _lights() {
    const key = new THREE.DirectionalLight(0xfff0dc, 2.4); key.position.set(0.35, 0.3, 1.4);
    const fill = new THREE.DirectionalLight(0xe4ecff, 0.8); fill.position.set(0.3, -0.8, 0.35);
    const rim = new THREE.DirectionalLight(0xcfe0ff, 1.8); rim.position.set(-0.7, -0.5, 0.6);
    const hemi = new THREE.HemisphereLight(0xffffff, 0x2a2b2f, 0.35);
    for (const l of [key, fill, rim, hemi]) l.layers.enable(7);      // 俯视格（只看 layer 7）也要有光
    this.scene.add(key, fill, rim, hemi);
    // 脚下的软接触阴影：一张径向渐变贴图，不用实时阴影（省 GPU，也没有硬边）
    const c = document.createElement('canvas'); c.width = c.height = 256;
    const ctx = c.getContext('2d');
    const grd = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
    grd.addColorStop(0, 'rgba(0,0,0,0.55)'); grd.addColorStop(0.5, 'rgba(0,0,0,0.2)'); grd.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grd; ctx.fillRect(0, 0, 256, 256);
    this.blob = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.26),
      new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false }));
    this.blob.layers.set(4);           // 只给自由视角看：三视图的俯视格里不要这团影子
    this.camera.layers.enable(4);
    this.scene.add(this.blob);
  }

  /** 关节角：robotd 的 robot.state.joints（弧度，按 JOINT_NAMES 顺序，已经标定过，原样用、不乘方向）。
   *  对应关系 review-impl-plan I13：joints[i] → 模型里名字是 JOINT_NAMES[i] 的那个关节。 */
  setJoints(arr) {
    if (!this.ready || !Array.isArray(arr)) return;
    // 鸭子站着不动时每帧数据几乎一样：没变就不重画（40 万面，一直画会让手机发烫）
    if (this._lastJoints && same(arr, this._lastJoints, 1e-4)) return;
    this._lastJoints = arr.slice();
    arr.forEach((rad, i) => {
      const j = this.joints[JOINT_NAMES[i]];
      if (j && typeof rad === 'number' && isFinite(rad)) j.pivot.quaternion.setFromAxisAngle(j.axis, rad);
    });
    if (this.layout === 'quad' && this._sel && performance.now() - (this._occAt || 0) > 400) this._orthoOccluders();
    this.dirty = true;
  }

  /** 机身坐标系里的重力方向（robot.state.safety.gravity，直立时约为 [0, 0, -1]）；null 表示没有数据，保持竖直。
   *  setFromUnitVectors 给的是最短旋转，只有俯仰和横滚，偏航永远为 0（不会转圈）。 */
  setGravity(g) {
    if (!this.ready) return;
    if (!g) { if (this._lastGravity) { this._lastGravity = null; this.trunk.quaternion.identity(); this.dirty = true; } return; }
    if (this._lastGravity && same(g, this._lastGravity, 1e-4)) return;
    this._lastGravity = g.slice();
    const v = new THREE.Vector3(...g);
    if (v.lengthSq() < 1e-6) return;
    this.trunk.quaternion.setFromUnitVectors(v.normalize(), new THREE.Vector3(0, 0, -1));
    this.dirty = true;
  }

  setView(view) { this.view = view; this._frame(); }

  // 明确的 CAD 绑定优先，避免嘴部外壳与偏航轴原点靠近而串号；其余保持既有配对。
  _mapServos() {
    this.scene.updateMatrixWorld(true);
    const servos = [];
    this.content.traverse((o) => { if (o.isMesh && o.userData.servo) servos.push(o); });
    const usedM = new Set(), usedJ = new Set();
    const bind = (m, name) => {
      usedM.add(m); usedJ.add(name);
      m.userData.joint = name;
      m.userData.baseColor = m.material.color.clone();
      this.servoOf[name] = m;
    };
    this.servoOf = {};
    for (const m of servos) {
      const name = m.userData.servoJoint;
      if (!name) continue;
      if (!this.joints[name] || usedJ.has(name)) throw new Error(`模型舵机绑定无效或重复：${name}`);
      bind(m, name);
    }
    const pairs = [];
    for (const m of servos) {
      const c = new THREE.Box3().setFromObject(m).getCenter(new THREE.Vector3());
      for (const [name, j] of Object.entries(this.joints)) {
        pairs.push([c.distanceTo(j.pivot.getWorldPosition(new THREE.Vector3())), m, name]);
      }
    }
    pairs.sort((a, b) => a[0] - b[0]);
    for (const [, m, name] of pairs) {
      if (usedM.has(m) || usedJ.has(name)) continue;
      bind(m, name);
    }
  }

  /** 屏幕坐标点到了哪个关节。先只跟 15 颗舵机比（壳挡不住：头壳里那几颗也点得中）；
   *  一颗舵机都没点中，再看点到了哪个零件，算带动它的那个关节。 */
  pick(clientX, clientY) {
    let cam = this.camera, ndc;
    if (this.layout === 'quad' && this.ortho) {
      const v = this._viewAt(clientX, clientY);
      if (!v) return null;
      cam = v.camera; ndc = v.ndc;
    } else {
      const r = this.canvas.getBoundingClientRect();
      ndc = new THREE.Vector2((clientX - r.left) / r.width * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    }
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, cam);
    const servo = ray.intersectObjects(Object.values(this.servoOf), false)[0];
    if (servo) return servo.object.userData.joint;
    const meshes = [];
    this.content.traverse((o) => { if (o.isMesh) meshes.push(o); });
    const hit = ray.intersectObjects(meshes, false)[0];
    return hit ? hit.object.userData.jointOf || null : null;
  }

  // 选中的舵机被壳挡着（头里那几颗）：挡在前面的零件变半透明，看得见它。换视角松手后重算
  _seeThrough() {
    for (const m of this._ghosted || []) {
      m.material.transparent = false; m.material.opacity = 1; m.material.depthWrite = true; m.material.needsUpdate = true;
    }
    this._ghosted = [];
    if (!this._sel) return;
    this.scene.updateMatrixWorld(true);
    const c = new THREE.Box3().setFromObject(this._sel).getCenter(new THREE.Vector3());
    const dir = c.clone().sub(this.camera.position);
    const dist = dir.length();
    const ray = new THREE.Raycaster(this.camera.position, dir.normalize(), 0, dist);
    const meshes = [];
    this.content.traverse((o) => { if (o.isMesh && o !== this._sel) meshes.push(o); });
    for (const h of ray.intersectObjects(meshes, false)) {
      if (h.distance < dist - 0.004 && !this._ghosted.includes(h.object)) {
        const m = h.object;
        m.material.transparent = true; m.material.opacity = 0.22; m.material.depthWrite = false; m.material.needsUpdate = true;
        this._ghosted.push(m);
      }
    }
    this.dirty = true;
  }

  /** 选中一颗舵机：外壳换成 color（用分组色），上一颗恢复原色。name 为 null 就全部恢复。 */
  select(name, color) {
    if (this._sel && this._sel.userData.baseColor) this._sel.material.color.copy(this._sel.userData.baseColor);
    this._sel = name ? this.servoOf[name] || null : null;
    if (this._sel) this._sel.material.color.set(color || '#2F7CF6');
    this._seeThrough();
    this.dirty = true;
  }

  /** 参照舵机（对准时拿来比的那几颗）：外壳换成 color，上一组恢复原色；正在选中的那颗不动（先 select 再调这个）。 */
  setRefs(names, color) {
    for (const m of this._refs || []) if (m !== this._sel && m.userData.baseColor) m.material.color.copy(m.userData.baseColor);
    this._refs = (names || []).map((n) => this.servoOf[n]).filter((m) => m && m !== this._sel);
    for (const m of this._refs) m.material.color.set(color || '#9AA0A6');
    this._orthoOccluders();
    this.dirty = true;
  }

  /** 'single'（一个自由视角，默认）或 'quad'（三视图 + 自由视角）。三视图里不能缩放（滚轮留给页面）。 */
  setLayout(mode) {
    const quad = mode === 'quad';
    if (quad === (this.layout === 'quad')) return;
    this.layout = quad ? 'quad' : 'single';
    if (quad) {
      this._zoomWas = this.controls.enableZoom;
      this.controls.enableZoom = false;
      this._orthoSetup();                 // 里面 _orthoFrame 会算一次遮挡
    } else {
      this.controls.enableZoom = this._zoomWas ?? true;
      this.controls.enabled = true;
    }
    this.resize();
  }

  /** 三视图的侧面看哪一侧：'left'（相机在鸭子左边，脸朝画面左）或 'right'。 */
  setSide(side) {
    const s = side === 'right' ? 'right' : 'left';
    if (s === this.side) return;
    this.side = s;
    if (this.ortho) this._orthoFrame();
  }

  _orthoSetup() {
    if (!this.ortho) {
      const cam = (layer, base) => { const c = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 4); c.layers.set(base); c.layers.enable(layer); return c; };
      this.ortho = { front: cam(1, 0), side: cam(2, 0), top: cam(3, 7) };
      // 方格：1 cm 细格 + 5 cm 粗格；GridHelper 默认躺在 xz 平面（法向 +y），转到各自那一格的视线方向
      const grid = (layer, n, opacity) => {
        const g = new THREE.GridHelper(0.6, n, 0xffffff, 0xffffff);
        g.material.transparent = true; g.material.opacity = opacity; g.material.depthWrite = false;
        g.layers.set(layer);
        this.scene.add(g);
        return g;
      };
      this.grids = {};
      for (const [k, layer] of [['front', 1], ['side', 2], ['top', 3]]) {
        this.grids[k] = [grid(layer, 60, 0.16), grid(layer, 12, 0.38)];
        for (const g of this.grids[k]) {
          if (k === 'front') g.rotation.z = -Math.PI / 2;      // 法向 +x
          if (k === 'top') g.rotation.x = Math.PI / 2;         // 法向 +z
        }
      }
    }
    this._orthoFrame();
  }

  // 三格的相机和方格：按现在的模型外框定一次（之后关节动了视角也不跟着变，看得出动了多少）
  _orthoFrame() {
    if (!this.ready || !this.ortho) return;
    this.scene.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(this.trunk);
    const c = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
    const sy = this.side === 'right' ? -1 : 1;
    const { front, side, top } = this.ortho;
    front.up.set(0, 0, 1); front.position.set(c.x + 1, c.y, c.z); front.lookAt(c);
    side.up.set(0, 0, 1); side.position.set(c.x, c.y + sy, c.z); side.lookAt(c);
    top.up.set(-1, 0, 0); top.position.set(c.x, c.y, c.z + 1); top.lookAt(c);     // 脸朝下
    for (const g of this.grids.front) g.position.set(box.min.x - 0.01, c.y, c.z);
    for (const g of this.grids.side) g.position.set(c.x, sy > 0 ? box.min.y - 0.01 : box.max.y + 0.01, c.z);
    for (const g of this.grids.top) g.position.set(c.x, c.y, box.min.z - 0.01);
    this._orthoNeed = { front: [size.y / 2, size.z / 2], side: [size.x / 2, size.z / 2], top: [size.y / 2, size.x / 2] };   // 横、竖各要多大
    this._orthoAspect();
    this._orthoOccluders();
    this.dirty = true;
  }

  // 三视图里也做「被挡住就把前面的零件变半透明」：每格各算一次挡在选中 / 参照舵机前面的零件，画那一格时才变透明、画完还原
  // （材质每个零件一份，三格和自由视角互不影响）。换选中、换侧面、换布局时算；关节动了最多每 0.4 秒重算一次（setJoints）
  _orthoOccluders() {
    this._occ = {};
    this._occAt = performance.now();
    if (this.layout !== 'quad' || !this.ortho || !this.ready) return;
    const targets = [this._sel, ...(this._refs || [])].filter(Boolean);
    if (!targets.length) return;
    this.scene.updateMatrixWorld(true);
    const meshes = [];
    this.content.traverse((o) => { if (o.isMesh && !targets.includes(o)) meshes.push(o); });
    for (const k of ['front', 'side', 'top']) {
      const dir = this.ortho[k].getWorldDirection(new THREE.Vector3()), hit = new Set();
      for (const t of targets) {
        const c = new THREE.Box3().setFromObject(t).getCenter(new THREE.Vector3());
        const ray = new THREE.Raycaster(c.clone().addScaledVector(dir, -2), dir, 0, 2 - 0.004);   // 从相机那边朝它打一条线
        ray.layers.set(k === 'top' ? 7 : 0);                                                     // 俯视那格只有腿
        for (const h of ray.intersectObjects(meshes, false)) hit.add(h.object);
      }
      this._occ[k] = [...hit];
    }
  }

  // 三格同一比例：取三格里最紧的那个（短边的半宽 s，长边按格子长宽比放大），再留一点边；自由那格的透视相机按它那格的长宽比
  _orthoAspect() {
    if (!this.ortho) return;
    const q = this._quad(), need = this._orthoNeed || { front: [0.1, 0.16], side: [0.1, 0.16], top: [0.1, 0.1] };
    let s = 0;
    for (const k of ['front', 'side', 'top']) {
      const a = q[k][2] / Math.max(q[k][3], 1), [nh, nv] = need[k];
      s = Math.max(s, a >= 1 ? Math.max(nv, nh / a) : Math.max(nh, nv * a));
    }
    s *= 1.12;
    for (const k of ['front', 'side', 'top']) {
      const cam = this.ortho[k], a = q[k][2] / Math.max(q[k][3], 1);
      if (a >= 1) { cam.left = -s * a; cam.right = s * a; cam.top = s; cam.bottom = -s; }
      else { cam.left = -s; cam.right = s; cam.top = s / a; cam.bottom = -s / a; }
      if (k !== 'top') cam.top += 0.14 * (cam.top - cam.bottom);   // 上面两格顶上压着姿势、视角两排按钮：鸭子往下放一点（两格一样，高度照样对齐）
      cam.updateProjectionMatrix();
    }
    this.camera.aspect = q.free[2] / Math.max(q.free[3], 1);
    this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
  }

  // 四格的位置（CSS 像素，WebGL 视口原点在左下角）：左上正面、右上侧面、左下俯视、右下自由；中间留 2 像素缝
  _quad() {
    const w = this.canvas.clientWidth || 1, h = this.canvas.clientHeight || 1;
    const hw = Math.floor(w / 2), hh = Math.floor(h / 2);
    return { front: [0, h - hh + 1, hw - 1, hh - 1], side: [hw + 1, h - hh + 1, w - hw - 1, hh - 1],
             top: [0, 0, hw - 1, h - hh - 1], free: [hw + 1, 0, w - hw - 1, h - hh - 1] };
  }

  // 屏幕坐标落在三视图的哪一格：那一格的名字、相机、格子里的 NDC
  _viewAt(clientX, clientY) {
    if (!this.ortho) return null;
    const r = this.canvas.getBoundingClientRect();
    const x = clientX - r.left, y = r.bottom - clientY;
    for (const [key, [qx, qy, qw, qh]] of Object.entries(this._quad())) {
      if (x >= qx && x < qx + qw && y >= qy && y < qy + qh) {
        return { key, camera: key === 'free' ? this.camera : this.ortho[key],
                 ndc: new THREE.Vector2((x - qx) / qw * 2 - 1, (y - qy) / qh * 2 - 1) };
      }
    }
    return null;
  }

  _render() {
    const r = this.renderer;
    if (this.layout !== 'quad' || !this.ortho) { r.render(this.scene, this.camera); return; }
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight, q = this._quad();
    r.setViewport(0, 0, w, h); r.clear();                 // 格子中间的缝也要清掉
    r.setScissorTest(true);
    for (const [k, cam] of [['front', this.ortho.front], ['side', this.ortho.side], ['top', this.ortho.top], ['free', this.camera]]) {
      r.setViewport(...q[k]); r.setScissor(...q[k]);
      const occ = (this._occ && this._occ[k]) || [];
      const was = occ.map((m) => [m.material.transparent, m.material.opacity, m.material.depthWrite]);
      for (const m of occ) { m.material.transparent = true; m.material.opacity = 0.22; m.material.depthWrite = false; m.material.needsUpdate = true; }
      r.render(this.scene, cam);
      occ.forEach((m, i) => { [m.material.transparent, m.material.opacity, m.material.depthWrite] = was[i]; m.material.needsUpdate = true; });
    }
    r.setScissorTest(false);
    r.setViewport(0, 0, w, h);
  }

  /** 慢慢转回默认机位（舞台上的「回正」按钮）。 */
  resetView() { this._snapAt = performance.now(); this.dirty = true; }

  _frame() {
    if (!this.ready) return;
    this.scene.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(this.trunk);
    const size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
    this.blob.position.set(center.x, center.y, box.min.z + 0.0008);
    const [azDeg, elDeg] = VIEWS[this.view] || VIEWS.front34;
    const az = THREE.MathUtils.degToRad(azDeg), el = THREE.MathUtils.degToRad(elDeg);
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const dist = (size.z / this.fill) / (2 * Math.tan(fov / 2));
    const look = new THREE.Vector3(center.x, center.y, box.min.z + size.z * 0.5);
    this.home = { pos: new THREE.Vector3(look.x + dist * Math.cos(el) * Math.cos(az), look.y + dist * Math.cos(el) * Math.sin(az), look.z + dist * Math.sin(el)), target: look };
    this.camera.position.copy(this.home.pos);
    this.controls.target.copy(look);
    this.controls.update();
    if (this.layout === 'quad' && this.ortho) this._orthoAspect(); else this._applyOffset();
    this.dirty = true;
  }

  // 让鸭子出现在画面的 (centerX, centerY) 处（给字让位）：平移相机的视锥，不动相机
  _applyOffset() {
    const w = this.canvas.clientWidth || 1, h = this.canvas.clientHeight || 1;
    this.camera.aspect = w / h;
    this.camera.setViewOffset(w, h, (0.5 - this.centerX) * w, (0.5 - this.centerY) * h, w, h);
    this.camera.updateProjectionMatrix();
  }

  resize() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    if (this.layout === 'quad' && this.ortho) this._orthoAspect(); else this._applyOffset();
    this.dirty = true;
  }

  _loop(now) {
    if (this._dead) return;
    if (this._snapAt && now > this._snapAt && this.home) {
      // 点了「回正」：慢慢转回默认机位
      this.camera.position.lerp(this.home.pos, 0.18);
      this.controls.target.lerp(this.home.target, 0.18);
      if (this.camera.position.distanceTo(this.home.pos) < 1e-4) this._snapAt = null;
      this.dirty = true;
    }
    if (this.controls.update()) this.dirty = true;
    // 页面切到后台、总览被藏起来（切到别的页）、舞台滚出了屏幕就不画（dirty 留着，回来再画）
    if (this.dirty && this.ready && !document.hidden && this._onScreen && this.canvas.offsetParent !== null) {
      this._render(); this.dirty = false; this.frames++;
    }
    requestAnimationFrame(this._loop);
  }

  dispose() {
    this._dead = true;
    this._resize.disconnect();
    if (this._io) this._io.disconnect();
    this.controls.dispose();
    // 材质、贴图是这个实例自己的，释放；几何体是共用缓存，不动
    this.scene.traverse((o) => {
      if (o.material) { o.material.map?.dispose(); o.material.dispose(); }
    });
    for (const gs of Object.values(this.grids || {})) for (const g of gs) g.geometry.dispose();   // 方格是自己的几何体
    this.scene.environment?.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();     // 浏览器同时能开的 WebGL 上下文有限，切几次页面就会用完
  }
}
