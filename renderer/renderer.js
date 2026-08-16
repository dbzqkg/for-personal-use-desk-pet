/* global PIXI, Live2DCubismCore */
'use strict';

const { Live2DModel } = PIXI.live2d;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const pick = arr => arr[Math.floor(Math.random() * arr.length)];

// ---------- 全局状态 ----------
let app = null;
let model = null;
let holder = null;           // 模型容器（缩放/定位都在容器上做，模型自身保持原始变换）
let canvas = null;
let state = null;
let bounds = null;            // 模型包围盒缓存（画布坐标）
let overInteractive = false;  // 鼠标是否悬停在模型上（决定窗口是否接收事件）
let dragging = false;
let dragMoved = 0;
let dragLast = null;
let sleeping = false;
let exprResetTimer = null;
let wheelAcc = 0;
let wheelTimer = null;
let firstFrame = true;
// 默认参数快照（模型文件内置 defaultValues），用于清除表情/动作残留
let defaultParams = null;
// 渲染校准：Cubism 5 核心与渲染库的矩阵语义差异（缩放+平移），加载后自动测量并修正
let calib = null; // { ax, ay, tx, ty }：视觉坐标 = JS坐标 × a + t
// 调整大小模式（双击宠物切换）：显示边框，右下角手柄拖动缩放
let resizeMode = false;
let resizeDragging = false;
let resizeStart = null;
let resizeFrameEl = null;
let resizeHandleEl = null;
let resizeLabelEl = null;
let lastTapTime = 0;
let tapTimer = null;
let rightClickFlag = false; // 右键不参与点击/拖动判定（右键只弹菜单，不切换表情）

const focus = { x: 0, y: 0, tx: 0, ty: 0 };

// 捕获模型默认参数（核心库内置 defaultValues，比渲染库的 _savedParameters 可靠）
function captureDefaultParams() {
  try {
    const core = model.internalModel.coreModel;
    const dv = core._model && core._model.parameters && core._model.parameters.defaultValues;
    if (dv && dv.length) defaultParams = Float32Array.from(dv);
    console.log('[pet] default params captured:', defaultParams ? defaultParams.length : 0,
      'savedLen=', (core._savedParameters || []).length);
  } catch (e) {
    console.warn('[pet] capture default failed:', e && e.message);
  }
}

// 恢复默认参数（返回是否成功）
function restoreDefaultParams() {
  if (!model || !defaultParams) return false;
  try {
    const core = model.internalModel.coreModel;
    const pv = core._parameterValues;
    if (pv && pv.length) {
      const n = Math.min(pv.length, defaultParams.length);
      for (let i = 0; i < n; i++) pv[i] = defaultParams[i];
      return true;
    }
  } catch (e) {}
  return false;
}

// ---------- 参数读写（含容错） ----------
function applyParams() {
  if (!model) return;
  const core = model.internalModel.coreModel;
  const set = (param, value) => {
    try { core.setParameterValueById(param, value); } catch (e) {}
  };
  if (sleeping) return;
  if (camActive) {
    // 摄像头模式：抑制 Idle 的哭/晕/汗参数，脸部完全由摄像头接管
    set('ParamCRY', 0);
    set('ParamDizzyEYE2', 0);
    set('ParamSweat1', 0);
    set('ParamSweat2', 0);
    set('ParamSweat3', 0);
    set('ParamSweat4', 0);
    // 身体姿态归零（避免开启前的残留侧倾）
    set('ParamBodyAngleX', 0);
    set('ParamBodyAngleY', 0);
    // 摄像头接管头部/眼睛/嘴（三个轴实测全反，统一取反；pitch 加抬升补偿防默认低头）
    set('ParamAngleX', -camSmooth.yaw * 30);
    set('ParamAngleY', camSmooth.pitch * 25 - 2);
    set('ParamAngleZ', -camSmooth.roll * 10);
    // 左右眼交换：检测的 Left 是画面左=用户右眼，映射到模型的另一侧才符合直觉
    set('ParamEyeLOpen', 0.05 + camSmooth.earR * 0.95);
    set('ParamEyeROpen', 0.05 + camSmooth.earL * 0.95);
    set('ParamMouthOpenY', camSmooth.mouth);
    set('ParamMouthForm', camSmooth.smile);
    return;
  }
  // 非摄像头模式：不抑制任何模型参数，Idle 表情与点击表情系统完整保留
  // 视线跟随：头/眼睛/身体朝向鼠标
  if (restoreEyesUntil && performance.now() < restoreEyesUntil) {
    set('ParamEyeLOpen', 1);
    set('ParamEyeROpen', 1);
    set('ParamMouthOpenY', 0);
    set('ParamAngleX', 0);
    set('ParamAngleY', 0);
    set('ParamAngleZ', 0);
    set('ParamBodyAngleX', 0);
    set('ParamBodyAngleY', 0);
  }
  set('ParamAngleX', focus.x * 25);
  set('ParamAngleY', -focus.y * 20); // 鼠标在上 → 抬头（正值）；原符号反了
  set('ParamEyeBallX', focus.x * 0.9);
  set('ParamEyeBallY', -focus.y * 0.9);
  set('ParamBodyAngleX', focus.x * 10);
  set('ParamBodyAngleY', focus.y * 5);
}

// ---------- 视线跟随 ----------
function setFocusTarget(x, y) {
  if (!app) return;
  const w = app.renderer.screen.width || 1;
  const h = app.renderer.screen.height || 1;
  focus.tx = clamp((x / w) * 2 - 1, -1, 1);
  focus.ty = clamp((y / h) * 2 - 1, -1, 1);
}

function updateFocus(dt) {
  if (sleeping) { focus.tx = 0; focus.ty = 0; }
  const k = Math.min(1, dt * 5);
  focus.x += (focus.tx - focus.x) * k;
  focus.y += (focus.ty - focus.y) * k;
}

// ---------- 摄像头面部捕捉（MediaPipe Face Landmarker） ----------
let camActive = false;
let camVideo = null;
let camStream = null;
let camLandmarker = null;
let camLastDetect = 0;
const camTarget = { yaw: 0, pitch: 0, roll: 0, earL: 1, earR: 1, mouth: 0, smile: 0 };
const camSmooth = { yaw: 0, pitch: 0, roll: 0, earL: 1, earR: 1, mouth: 0, smile: 0 };
let restoreEyesUntil = 0; // 关闭摄像头后一段时间内强制睁眼（毫秒时间戳）
// pitch 中性基线：启动后前 2 秒采样（自然坐姿下鼻尖低于眼角会导致恒低头）
const camPitchBase = { value: 0, samples: 0, ready: false };
// 眨眼自适应基线：跟踪平时 eyeBlink 的噪声水平，只有明显超过基线的才视为眨眼
const camBlinkBase = { l: 0.06, r: 0.06 };

async function startCamera() {
  try {
    const mp = window.__mediapipe;
    if (!mp) {
      console.warn('[pet] mediapipe 未就绪');
      return;
    }
    if (!camLandmarker) {
      const wasmUrl = new URL('../node_modules/@mediapipe/tasks-vision/wasm', document.baseURI).href;
      const modelUrl = new URL('../vendor/face_landmarker.task', document.baseURI).href;
      const fileset = await mp.FilesetResolver.forVisionTasks(wasmUrl);
      camLandmarker = await mp.FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: modelUrl, delegate: 'GPU' },
        runningMode: 'VIDEO',
        numFaces: 1,
        outputFaceBlendshapes: true,               // 直接用官方表情系数（眨眼/张嘴/微笑 0~1）
        outputFacialTransformationMatrixes: true,  // 官方头部姿态矩阵
      });
      console.log('[pet] face landmarker ready');
    }
    camStream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: 'user' },
      audio: false,
    });
    camVideo = document.createElement('video');
    camVideo.muted = true;
    camVideo.playsInline = true;
    camVideo.srcObject = camStream;
    camVideo.className = 'cam-preview';
    if (state && state.camPreview === false) camVideo.style.display = 'none';
    document.body.appendChild(camVideo); // 预览小窗（右下角，镜像）
    await camVideo.play();
    camActive = true;
    camLastDetect = 0;
    camSmooth.__logged = false;
    camPitchBase.value = 0;
    camPitchBase.samples = 0;
    camPitchBase.ready = false;
    console.log('[pet] camera started');
  } catch (e) {
    console.warn('[pet] camera failed:', e && (e.message || e));
    camActive = false;
    stopCamera();
  }
}

function stopCamera() {
  camActive = false;
  // 关闭后 1.5 秒内每帧强制睁眼，之后交还模型自动眨眼（loadParameters 一次性恢复不可靠）
  restoreEyesUntil = performance.now() + 1500;
  if (camStream) {
    try { camStream.getTracks().forEach(t => t.stop()); } catch (e) {}
    camStream = null;
  }
  if (camVideo) {
    try { camVideo.srcObject = null; } catch (e) {}
    try { camVideo.remove(); } catch (e) {}
    camVideo = null;
  }
}

async function toggleCamera() {
  if (camActive) {
    stopCamera();
    console.log('[pet] camera stopped');
    window.petAPI.setCameraState(false);
  } else {
    await startCamera();
    window.petAPI.setCameraState(camActive);
  }
}

// 基于 MediaPipe 官方输出的表情系数（blendshapes）与 landmark 几何姿态
function extractCamValues(res, p) {
  const s = (state && state.camSens) || { blink: 4, mouth: 6, head: 2.2, pitch: 2.2 };
  try {
    // 表情系数：eyeBlinkLeft/Right（1=闭眼）、jawOpen（张嘴）、mouthSmileLeft/Right（微笑）
    if (res.faceBlendshapes && res.faceBlendshapes.length && res.faceBlendshapes[0].categories) {
      const bs = {};
      for (const c of res.faceBlendshapes[0].categories) bs[c.categoryName] = c.score;
      // 眨眼：基线慢速自适应（瞬时眨眼不会显著抬高基线；旧实现瞬跟峰值会把眨眼动作吃掉）
      const rawBL = bs.eyeBlinkLeft || 0;
      const rawBR = bs.eyeBlinkRight || 0;
      camBlinkBase.l = Math.min(0.4, camBlinkBase.l + (rawBL - camBlinkBase.l) * 0.02);
      camBlinkBase.r = Math.min(0.4, camBlinkBase.r + (rawBR - camBlinkBase.r) * 0.02);
      const normL = clamp(((rawBL - camBlinkBase.l) / Math.max(0.2, 1 - camBlinkBase.l)) * s.blink, 0, 1);
      const normR = clamp(((rawBR - camBlinkBase.r) / Math.max(0.2, 1 - camBlinkBase.r)) * s.blink, 0, 1);
      camTarget.earL = 1 - normL;
      camTarget.earR = 1 - normR;
      camTarget.mouth = clamp((bs.jawOpen || 0) * s.mouth, 0, 1);
      camTarget.smile = clamp(((bs.mouthSmileLeft || 0) + (bs.mouthSmileRight || 0)) / 2 * 1.6, 0, 1);
    }
    // 头部姿态：landmark 几何（比矩阵提取稳，实测方向可靠）
    if (p) {
      const faceW = Math.max(0.5, p[263].x - p[33].x);
      const yawRaw = (p[1].x - (p[33].x + p[263].x) / 2) / faceW;
      const pitchRaw = ((p[33].y + p[263].y) / 2 - p[1].y) / faceW;
      const rollRaw = Math.atan2(p[263].y - p[33].y, p[263].x - p[33].x);
      camTarget.yaw = clamp(yawRaw * 3 * s.head, -1, 1);
      // pitch 前 2 秒采样自然基线（消除"一直低头"）
      if (!camPitchBase.ready) {
        camPitchBase.value += pitchRaw;
        camPitchBase.samples++;
        if (camPitchBase.samples >= 30) {
          camPitchBase.value /= camPitchBase.samples;
          camPitchBase.ready = true;
          console.log('[pet] pitch baseline ready:', camPitchBase.value.toFixed(3));
        }
        camTarget.pitch = 0;
      } else {
        camTarget.pitch = clamp((pitchRaw - camPitchBase.value) * 3 * (s.pitch ?? s.head), -1, 1);
      }
      camTarget.roll = clamp(rollRaw * 2 * s.head, -1, 1);
    }
  } catch (e) {}
}

function updateCamera(dt) {
  if (!camActive || !camLandmarker || !camVideo || camVideo.readyState < 2) return;
  const now = performance.now();
  if (now - camLastDetect < 66) return; // 约 15fps 检测
  camLastDetect = now;
  let res = null;
  try {
    res = camLandmarker.detectForVideo(camVideo, now);
  } catch (e) {}
  if (res && res.faceLandmarks && res.faceLandmarks.length) {
    extractCamValues(res, res.faceLandmarks[0]);
    if (!camSmooth.__logged) {
      camSmooth.__logged = true;
      console.log('[pet] camera face detected, mapping via blendshapes');
    }
  } else {
    // 未检测到人脸：缓慢回到默认（睁眼、闭嘴）
    camTarget.earL = camTarget.earR = 1;
    camTarget.mouth = 0;
    camTarget.yaw = camTarget.pitch = camTarget.roll = 0;
  }
  // 眼睛快速跟踪（眨眼是快速动作，不能慢平滑），头/嘴正常平滑
  const kEye = Math.min(1, dt * 25);
  camSmooth.earL += (camTarget.earL - camSmooth.earL) * kEye;
  camSmooth.earR += (camTarget.earR - camSmooth.earR) * kEye;
  const k = Math.min(1, dt * 6);
  camSmooth.yaw += (camTarget.yaw - camSmooth.yaw) * k;
  camSmooth.pitch += (camTarget.pitch - camSmooth.pitch) * k;
  camSmooth.roll += (camTarget.roll - camSmooth.roll) * k;
  camSmooth.mouth += (camTarget.mouth - camSmooth.mouth) * k;
  camSmooth.smile += (camTarget.smile - camSmooth.smile) * k;
}

// ---------- 点击部位 → 区域分类 ----------
function classifyHitArea(name) {
  const n = String(name || '').toLowerCase();
  if (/head|头|脸|face|hair|髪|目|eye|ear|耳|口|mouth|ほお|額|颊/.test(n)) return 'head';
  if (/chest|胸|breast|bust|おっぱい/.test(n)) return 'chest';
  if (/body|体|torso|belly|腹|おなか|腰|waist/.test(n)) return 'body';
  if (/hand|手|arm|腕|shoulder|肩/.test(n)) return 'hand';
  if (/leg|脚|足|foot|腿|shoe|靴|skirt|スカート/.test(n)) return 'leg';
  return 'other';
}

function classifyRegion(x, y) {
  if (!bounds || !bounds.width || !bounds.height) return 'other';
  const rx = (x - bounds.x) / bounds.width;
  const ry = (y - bounds.y) / bounds.height;
  if (ry < 0.25 && Math.abs(rx - 0.5) < 0.30) return 'head';
  if (ry < 0.62) {
    if (rx < 0.15 || rx > 0.85) return 'hand';
    if (ry < 0.40) return 'chest';
    return 'body';
  }
  return 'leg';
}

// ---------- 反应（仅表情，程序化参数动画已移除） ----------
let formName = ''; // 形态：持续生效的表情（后四个表情专用），'' = 无
function applyExpressionPersistent(name) {
  if (!model) return;
  try {
    const em = model.internalModel.motionManager.expressionManager;
    try {
      if (em.stopAllExpressions) em.stopAllExpressions();
      em.resetExpression();
      restoreDefaultParams();
    } catch (e) {}
    clearTimeout(exprResetTimer);
    model.expression(name).then(ok => {
      if (!ok) console.warn('[pet] form expression failed:', name);
    });
  } catch (e) {
    console.warn('[pet] form expression error:', name, e && e.message);
  }
}
function setForm(name) {
  formName = String(name || '');
  console.log('[pet] form set:', formName || '(默认)');
  if (!formName) {
    clearTimeout(exprResetTimer);
    try {
      const em = model && model.internalModel.motionManager.expressionManager;
      if (em) {
        if (em.stopAllExpressions) em.stopAllExpressions();
        em.resetExpression();
      }
      restoreDefaultParams();
    } catch (e) {}
    return;
  }
  applyExpressionPersistent(formName);
}
function setExpression(name) {
  if (!model) return;
  try {
    const core = model.internalModel.coreModel;
    const em = model.internalModel.motionManager.expressionManager;
    // 播放新表情前：停止所有旧表情 + 恢复默认参数清除残留
    try {
      if (em.stopAllExpressions) em.stopAllExpressions();
      em.resetExpression();
      restoreDefaultParams();
    } catch (e) {}
    if (name === null || name === undefined) {
      clearTimeout(exprResetTimer);
      return;
    }
    if (name === '') {
      if (em.definitions && em.definitions.length) {
        model.expression(Math.floor(Math.random() * em.definitions.length));
      }
    } else {
      model.expression(name).then(ok => {
        if (!ok) console.warn('[pet] expression play failed:', name);
      });
    }
    clearTimeout(exprResetTimer);
    exprResetTimer = setTimeout(() => {
      try {
        const em2 = model.internalModel.motionManager.expressionManager;
        if (em2.stopAllExpressions) em2.stopAllExpressions();
        em2.resetExpression();
        restoreDefaultParams(); // 清除表情残留参数
      } catch (e) {}
      if (formName) applyExpressionPersistent(formName); // 临时表情结束后恢复形态
    }, 3000);
  } catch (e) {
    console.warn('[pet] expression failed:', name, e && e.message);
  }
}

function tapReaction(region) {
  if (!model) return;
  if (sleeping) wakeUp();
  // 1) 模型自带 tap 动作优先
  const groups = (state.model && state.model.motionGroups) || [];
  const tapGroups = groups.filter(g => /tap|click|touch|press/i.test(g));
  const kw = {
    head: ['head', '头', 'face', '脸', 'hair', '髪'],
    chest: ['chest', 'breast', '胸'],
    body: ['body', 'belly', '腹', '体', 'torso'],
    hand: ['hand', 'arm', '手', '腕'],
    leg: ['leg', 'foot', '脚', '足'],
  }[region] || [];
  const candidates = tapGroups.filter(g => kw.some(k => g.toLowerCase().includes(k.toLowerCase())));
  if (candidates.length && playMotionGroup(pick(candidates))) return;
  // 2) 表情反应
  const pools = {
    head: ['Blush', 'Love', 'Dizzy', 'Star Eye', 'Exp eye', 'chibi'],
    chest: ['Love', 'Blush', 'Sweat'],
    body: ['Love', 'Blush', 'Sweat'],
    hand: ['Blush', 'Sweat'],
    leg: ['Sweat', 'Cry'],
    other: ['Blush', 'Love', 'Sweat'],
  };
  const exprs = (state.model && state.model.expressions) || [];
  const pool = (pools[region] || []).filter(n => exprs.some(e => e.toLowerCase().includes(n.toLowerCase())));
  if (pool.length) setExpression(pick(pool));
}

// ---------- 动作 / 睡觉 ----------
function playMotionGroup(group) {
  if (!model || !group) return false;
  try {
    const defs = model.internalModel.motionManager.definitions[group];
    if (!defs || !defs.length) return false;
    model.motion(group, Math.floor(Math.random() * defs.length));
    return true;
  } catch (e) {
    return false;
  }
}

function goSleep() {
  if (!model) return;
  if (playMotionGroup('Sleep')) {
    sleeping = true;
    focus.tx = 0;
    focus.ty = 0;
  }
}

function wakeUp() {
  if (!model) return;
  try { model.internalModel.motionManager.stopAllMotions(); } catch (e) {}
  sleeping = false;
  // 恢复默认参数（清除睡眠动作残留的睡姿/闭眼）
  restoreDefaultParams();
  // 唤醒后 2 秒内强制睁眼（默认参数可能是半闭状态）
  restoreEyesUntil = performance.now() + 2000;
  // 用 FORCE 优先级强制启动 Idle（普通优先级可能被运动状态拒绝，导致"叫不醒"）
  let ok = false;
  try {
    const mm = model.internalModel.motionManager;
    const defs = mm.definitions && mm.definitions['Idle'];
    if (defs && defs.length) {
      const r = mm.startMotion('Idle', Math.floor(Math.random() * defs.length), 3);
      ok = r !== false;
      if (r && r.then) r.then(v => console.log('[pet] wakeUp idle force start:', v));
    }
  } catch (e) {}
  if (!ok && !playMotionGroup('Idle')) {
    const groups = Object.keys(model.internalModel.motionManager.definitions || {});
    playMotionGroup(pick(groups));
  }
}

// ---------- 交互判定 ----------
function isOverModel(x, y) {
  if (!model || !bounds) return false;
  try {
    const p = toJsPoint(x, y);
    const hits = model.hitTest(p.x, p.y);
    if (hits && hits.length) return true;
  } catch (e) {}
  const pad = 10;
  return x >= bounds.x - pad && x <= bounds.x + bounds.width + pad &&
         y >= bounds.y - pad && y <= bounds.y + bounds.height + pad;
}

function setInteractive(v) {
  if (v !== overInteractive) {
    overInteractive = v;
    window.petAPI.setInteractive(v);
  }
}

function updateInteractive(x, y) {
  if (dragging || resizeMode) return;
  setInteractive(isOverModel(x, y));
}

function handleTap(x, y) {
  if (!model) return;
  let region = 'other';
  try {
    const p = toJsPoint(x, y);
    const hits = model.hitTest(p.x, p.y);
    if (hits && hits.length) region = classifyHitArea(hits[0]);
    else region = classifyRegion(x, y);
  } catch (e) {
    region = classifyRegion(x, y);
  }
  tapReaction(region);
}

// ---------- DOM 事件 ----------
function onPointerDown(e) {
  if (e.button === 2) {
    rightClickFlag = true;
    return; // 右键：只弹菜单，不进入拖动/点击
  }
  rightClickFlag = false;
  dragging = true;
  dragMoved = 0;
  dragLast = { x: e.screenX, y: e.screenY };
  // 按下即取消待执行的单击反应（用户可能是要拖动或双击）
  clearTimeout(tapTimer);
  tapTimer = null;
  try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
}

function onPointerMove(e) {
  if (dragging && dragLast) {
    const dx = e.screenX - dragLast.x;
    const dy = e.screenY - dragLast.y;
    dragLast = { x: e.screenX, y: e.screenY };
    dragMoved += Math.abs(dx) + Math.abs(dy);
    window.petAPI.dragWindow(dx, dy);
  }
  setFocusTarget(e.clientX, e.clientY);
  updateInteractive(e.clientX, e.clientY);
}

function onPointerUp(e) {
  if (rightClickFlag) {
    rightClickFlag = false;
    return; // 右键抬起：不触发点击反应
  }
  const wasDragging = dragging;
  dragging = false;
  dragLast = null;
  const movedLittle = wasDragging && dragMoved < 6;
  dragMoved = 0;
  if (movedLittle) {
    // 双击检测：两次轻点（间隔<450ms）切换调整大小模式；否则延迟执行点击反应
    const now = performance.now();
    if (now - lastTapTime < 450) {
      clearTimeout(tapTimer);
      tapTimer = null;
      lastTapTime = 0;
      toggleResizeMode();
    } else {
      lastTapTime = now;
      tapTimer = setTimeout(() => {
        tapTimer = null;
        handleTap(e.clientX, e.clientY);
      }, 280);
    }
  } else {
    lastTapTime = 0; // 拖动结束，重置双击检测
  }
  updateInteractive(e.clientX, e.clientY);
}

function onWheel(e) {
  e.preventDefault();
  wheelAcc += e.deltaY < 0 ? 0.06 : -0.06;
  clearTimeout(wheelTimer);
  wheelTimer = setTimeout(() => {
    if (wheelAcc) {
      window.petAPI.adjustScale(wheelAcc);
      wheelAcc = 0;
    }
  }, 70);
}

// ---------- 调整大小模式（边框 + 手柄） ----------
function updateScaleLabel() {
  if (resizeLabelEl) resizeLabelEl.textContent = Math.round((state ? state.scale : 1) * 100) + '%';
}

function toggleResizeMode() {
  resizeMode = !resizeMode;
  if (resizeFrameEl) resizeFrameEl.style.display = resizeMode ? 'block' : 'none';
  updateScaleLabel();
  updateChatBar();
  window.petAPI.setResizeMode(resizeMode);
  if (!resizeMode) {
    // 退出后恢复点击穿透判定（等下一次鼠标移动重新评估）
    setInteractive(false);
  }
}

// ---------- AI 对话（气泡 + 输入 + 系统语音 + 嘴型） ----------
let chatBubbleEl = null;
let chatBarEl = null;
let chatInputEl = null;
let chatSendBtnEl = null;
let chatMicBtnEl = null;
let chatBubbleTimer = null;
let chatCfg = null; // { enabled, voice, bubbleTime, bgImage }

function applyChatCfg(cfg) {
  chatCfg = cfg || chatCfg;
  updateChatBar();
  updateAlwaysListening();
  if (chatBubbleEl && chatCfg) {
    if (chatCfg.bgImage) {
      chatBubbleEl.style.backgroundImage = 'url("' + chatCfg.bgImage + '")';
      chatBubbleEl.style.background = 'rgba(255,255,255,0.95)';
      chatBubbleEl.style.backgroundImage = 'url("' + chatCfg.bgImage + '")';
    } else {
      chatBubbleEl.style.backgroundImage = '';
    }
  }
}

function updateChatBar() {
  if (!chatBarEl) return;
  const show = resizeMode && chatCfg && chatCfg.enabled;
  chatBarEl.style.display = show ? 'flex' : 'none';
  // 全程监听模式下隐藏手动麦克风按钮（常驻收音）
  if (chatMicBtnEl) chatMicBtnEl.style.display = (chatCfg && chatCfg.micMode === 'always') ? 'none' : '';
  if (show) {
    setTimeout(() => { try { chatInputEl.focus(); } catch (e) {} }, 100);
  }
  refreshIndicator();
}

function showBubble(text, thinking) {
  if (!chatBubbleEl) return;
  chatBubbleEl.textContent = '';
  if (thinking) { // 思考模式：思考过程灰色小字显示在回答上方
    const t = document.createElement('div');
    t.className = 'think-box';
    t.textContent = '思考：' + thinking;
    chatBubbleEl.appendChild(t);
  }
  const a = document.createElement('div');
  a.textContent = text;
  chatBubbleEl.appendChild(a);
  chatBubbleEl.style.display = 'block';
  clearTimeout(chatBubbleTimer);
  const secs = (chatCfg && chatCfg.bubbleTime) || 8;
  chatBubbleTimer = setTimeout(() => {
    chatBubbleEl.style.display = 'none';
  }, secs * 1000);
}

// 语音朗读：Piper 本地合成 WAV → 指定输出设备播放（可接变声器）+ 嘴型脉冲
async function speakReply(text) {
  if (!chatCfg || chatCfg.voice === false) return;
  const ttsDone = () => {
    localTtsActive = false;
    localTtsEndAt = Date.now();
    window.petAPI.setTtsActive(false);
  };
  try {
    const r = await window.petAPI.chatTts(text);
    if (r && r.ok) {
      localTtsActive = true;
      window.petAPI.setTtsActive(true); // 朗读期间暂停全程监听，防喇叭回声回环
      const audio = new Audio(r.url);
      try {
        if (chatCfg.outputDevice && audio.setSinkId) {
          await audio.setSinkId(chatCfg.outputDevice);
        }
      } catch (e) {}
      audio.addEventListener('ended', ttsDone);
      audio.addEventListener('error', ttsDone);
      audio.play().catch(ttsDone);
      mouthPulseLoop(audio);
      return;
    }
  } catch (e) {}
  // 兜底：系统语音（无词边界时用 onend；日语文本用日语系统语音）
  try {
    if (!('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = /[\u3040-\u30ff]/.test(String(text)) ? 'ja-JP' : 'zh-CN';
    u.rate = 1.1;
    localTtsActive = true;
    window.petAPI.setTtsActive(true);
    u.onend = ttsDone;
    u.onerror = ttsDone;
    window.speechSynthesis.speak(u);
  } catch (e) {}
}

let mouthPulseTimer = null;
function mouthPulseLoop(audio) {
  clearInterval(mouthPulseTimer);
  mouthPulseTimer = setInterval(() => {
    if (!audio || audio.ended || audio.paused || audio.error) {
      clearInterval(mouthPulseTimer);
      return;
    }
    if (!model) return;
    try {
      model.internalModel.coreModel.setParameterValueById('ParamMouthOpenY', 0.35 + Math.random() * 0.55);
    } catch (e) {}
  }, 150);
}

async function sendChat() {
  const text = (chatInputEl.value || '').trim();
  if (!text) return;
  chatInputEl.value = '';
  showBubble('…');
  const r = await window.petAPI.chatSend(text);
  if (r && r.ok) {
    showBubble(r.reply, r.thinking || '');
    speakReply(r.reply); // 语音只朗读最终回答，不朗读思考
  } else {
    showBubble('（' + ((r && r.error) || '出错了') + '）');
  }
}

// ---------- 语音输入（本地 whisper.cpp 优先，离线免 key；缺失时退回在线识别） ----------
let recog = null;
let micListening = false;
let micStarting = false;   // getUserMedia 初始化中
let micPendingStop = false; // 初始化完成前收到停止请求
let micStream = null;
let micAudioCtx = null;
let micChunks = [];
let micTimer = null;
let micSrcRate = 48000;
let whisperReady = null; // null=未知 true/false
let micIndicatorEl = null;
let vadActive = false; // 当前检测到人声（手动录音或全程监听 VAD）
let localTtsActive = false; // 本地朗读状态（全程监听据此暂停收音）
let localTtsEndAt = 0;

function refreshIndicator() {
  if (!micIndicatorEl) return;
  const always = !!(chatCfg && chatCfg.micMode === 'always');
  if (micListening || vadActive) { // 正在听/检测到说话：红色脉冲
    micIndicatorEl.style.display = 'flex';
    micIndicatorEl.style.opacity = '1';
    micIndicatorEl.style.animation = 'micpulse 1s infinite';
    micIndicatorEl.style.borderColor = '#e33';
  } else if (always) { // 全程监听待机：灰色常亮
    micIndicatorEl.style.display = 'flex';
    micIndicatorEl.style.opacity = '0.55';
    micIndicatorEl.style.animation = 'none';
    micIndicatorEl.style.borderColor = '#999';
  } else {
    micIndicatorEl.style.display = 'none';
  }
}

function setMicUI(on) {
  if (!chatMicBtnEl) return;
  chatMicBtnEl.textContent = on ? '🔴' : '🎤';
  chatMicBtnEl.classList.toggle('listening', on);
  chatMicBtnEl.title = on ? '正在听…' : '语音输入（本地识别）';
  refreshIndicator();
}

// Float32 采样 → 16kHz 单声道 16bit WAV ArrayBuffer
function buildWav16k(chunks, srcRate) {
  let total = 0;
  for (const c of chunks) total += c.length;
  if (!total) return null;
  const mono = new Float32Array(total);
  let off = 0;
  for (const c of chunks) { mono.set(c, off); off += c.length; }
  const outLen = Math.max(1, Math.round(mono.length * 16000 / srcRate));
  const pcm = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const s = i * srcRate / 16000;
    const s0 = Math.floor(s);
    const s1 = Math.min(mono.length - 1, s0 + 1);
    let v = mono[s0] * (1 - (s - s0)) + mono[s1] * (s - s0);
    v = Math.max(-1, Math.min(1, v));
    pcm[i] = v < 0 ? v * 0x8000 : v * 0x7FFF;
  }
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const dv = new DataView(buf);
  const ws = (p, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(p + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); dv.setUint32(4, 36 + pcm.length * 2, true); ws(8, 'WAVE');
  ws(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, 16000, true); dv.setUint32(28, 32000, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  ws(36, 'data'); dv.setUint32(40, pcm.length * 2, true);
  new Int16Array(buf, 44).set(pcm);
  return buf;
}

function teardownMic() {
  micListening = false;
  micStarting = false;
  setMicUI(false);
  clearTimeout(micTimer);
  try { micStream && micStream.getTracks().forEach(t => t.stop()); } catch (e) {}
  try { micAudioCtx && micAudioCtx.close(); } catch (e) {}
  micStream = null;
  micAudioCtx = null;
}

async function stopMicAndTranscribe() {
  if (micStarting) { micPendingStop = true; return; } // 还在初始化，先挂起停止请求
  teardownMic();
  let samples = 0;
  for (const c of micChunks) samples += c.length;
  const dur = (samples / micSrcRate).toFixed(1);
  console.log('[voice] 停止录音 chunks=' + micChunks.length + ' samples=' + samples + ' sr=' + micSrcRate + ' 时长=' + dur + ' 秒');
  const wav = buildWav16k(micChunks, micSrcRate);
  micChunks = [];
  if (!wav) return;
  showBubble('（识别中…）');
  const r = await window.petAPI.voiceStt(wav);
  console.log('[voice] 识别返回:', r && r.ok, (r && r.text) || (r && r.error));
  if (r && r.ok && r.text && r.text.trim()) {
    chatInputEl.value = r.text.trim();
    sendChat(); // 识别完成自动发送
  } else {
    showBubble('（没听清：' + ((r && r.error) || '未知错误') + '）');
  }
}

async function startLocalListening() {
  try {
    const audioCfg = chatCfg && chatCfg.inputDevice ? { deviceId: { exact: chatCfg.inputDevice } } : true;
    micStream = await navigator.mediaDevices.getUserMedia({ audio: audioCfg });
  } catch (e) {
    micStarting = false;
    console.log('[voice] 麦克风打开失败:', e && e.message);
    showBubble('（麦克风不可用：' + (e && e.message ? e.message : '未知') + '）');
    return;
  }
  micChunks = [];
  micAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  micSrcRate = micAudioCtx.sampleRate;
  const src = micAudioCtx.createMediaStreamSource(micStream);
  const sp = micAudioCtx.createScriptProcessor(4096, 1, 1);
  sp.onaudioprocess = e => {
    if (micListening) micChunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  };
  src.connect(sp);
  sp.connect(micAudioCtx.destination);
  micStarting = false;
  micListening = true;
  setMicUI(true);
  console.log('[voice] 开始录音 sr=' + micSrcRate + ' device=' + (chatCfg && chatCfg.inputDevice ? chatCfg.inputDevice.slice(0, 24) : '默认'));
  micTimer = setTimeout(stopMicAndTranscribe, 15000); // 最多听 15 秒自动停止
  if (micPendingStop) { micPendingStop = false; stopMicAndTranscribe(); }
}

// 在线识别兜底（whisper 未安装时）
function startOnlineListening() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { showBubble('（whisper 未安装，且当前环境不支持在线识别）'); return; }
  try {
    recog = new SR();
    recog.lang = 'zh-CN';
    recog.interimResults = true;
    recog.onresult = ev => {
      let finalText = '';
      let interim = '';
      for (let i = 0; i < ev.results.length; i++) {
        if (ev.results[i].isFinal) finalText += ev.results[i][0].transcript;
        else interim += ev.results[i][0].transcript;
      }
      finalText = finalText.trim();
      if (finalText) {
        teardownMic();
        chatInputEl.value = finalText;
        sendChat();
      } else if (interim) {
        chatInputEl.value = interim;
      }
    };
    recog.onerror = ev => {
      teardownMic();
      const msg = ev.error === 'not-allowed' ? '麦克风权限被拒绝'
        : ev.error === 'network' ? '在线识别连不上服务（国内网络可能需要代理）'
        : '语音识别出错：' + (ev.error || '未知');
      showBubble('（' + msg + '）');
    };
    recog.onend = () => { if (micListening) teardownMic(); };
    micStarting = false;
    micListening = true;
    setMicUI(true);
    console.log('[voice] 在线识别开始（whisper 未安装）');
    recog.start();
  } catch (e) {
    teardownMic();
    showBubble('（语音识别启动失败）');
  }
}

async function toggleVoiceInput() {
  if (micListening) { await stopMicAndTranscribe(); return; } // 第二击 = 停止并识别
  micStarting = true;
  if (whisperReady === null) {
    try { whisperReady = await window.petAPI.voiceSttReady(); } catch (e) { whisperReady = false; }
  }
  console.log('[voice] 本地识别引擎可用:', whisperReady);
  if (whisperReady) await startLocalListening();
  else startOnlineListening();
}

// ---------- 全程监听：本地连续采集 + 能量 VAD 断句 + 逐句识别（sherpa 0.1 秒级） ----------
let alwaysRec = null;       // { stream, ctx, sp, sr, noiseFloor, inSpeech, silSec, uttChunks, uttSec, closed }
let alwaysFlushing = false;
function ttsSuppressedLocal() {
  if (localTtsActive) return true;
  const delay = (chatCfg && typeof chatCfg.ttsEchoDelay === 'number') ? chatCfg.ttsEchoDelay : 0.1;
  return Date.now() < localTtsEndAt + Math.max(0, delay) * 1000;
}
function onAlwaysChunk(e) {
  const rec = alwaysRec;
  if (!rec || rec.closed) return;
  const c = new Float32Array(e.inputBuffer.getChannelData(0));
  if (ttsSuppressedLocal()) { // 朗读中/回声期：整段丢弃
    rec.uttChunks = []; rec.uttSec = 0; rec.inSpeech = false; rec.silSec = 0;
    if (vadActive) { vadActive = false; refreshIndicator(); }
    return;
  }
  let s = 0;
  for (let i = 0; i < c.length; i++) s += c[i] * c[i];
  const rms = Math.sqrt(s / c.length);
  if (!rec.inSpeech) rec.noiseFloor = rec.noiseFloor * 0.98 + rms * 0.02; // 慢速跟踪噪声底
  const mult = 2 + ((chatCfg && typeof chatCfg.vadThold === 'number') ? chatCfg.vadThold : 0.75) * 6;
  const thresh = Math.max(rec.noiseFloor * mult, 0.004);
  const dur = c.length / rec.sr;
  if (rms > thresh) {
    if (!rec.inSpeech) {
      rec.inSpeech = true;
      vadActive = true;
      refreshIndicator();
      console.log('[voice] VAD 检测到说话 rms=' + rms.toFixed(4) + ' floor=' + rec.noiseFloor.toFixed(4));
    }
    rec.silSec = 0;
    rec.uttChunks.push(c);
    rec.uttSec += dur;
  } else if (rec.inSpeech) {
    rec.uttChunks.push(c);
    rec.uttSec += dur;
    rec.silSec += dur;
    if (rec.silSec >= 0.6 || rec.uttSec >= 20) flushAlwaysUtterance(); // 静默 0.6s 或最长 20s 断句
  }
}
async function flushAlwaysUtterance() {
  const rec = alwaysRec;
  if (!rec || rec.closed || alwaysFlushing) return;
  const chunks = rec.uttChunks;
  const sr = rec.sr;
  rec.uttChunks = [];
  rec.uttSec = 0;
  rec.inSpeech = false;
  rec.silSec = 0;
  vadActive = false;
  refreshIndicator();
  const wav = buildWav16k(chunks, sr);
  if (!wav || wav.byteLength < 44 + 16000 * 0.3 * 2) return; // 短于 0.3 秒视为噪声
  alwaysFlushing = true;
  try {
    console.log('[voice] 断句完成，时长≈' + (wav.byteLength / 32000).toFixed(1) + ' 秒，识别中');
    const r = await window.petAPI.voiceStt(wav);
    console.log('[voice] 全程监听识别:', r && r.ok, (r && r.text) || (r && r.error));
    if (r && r.ok && r.text && r.text.trim()) {
      chatInputEl.value = r.text.trim();
      sendChat();
    }
  } finally {
    alwaysFlushing = false;
  }
}
async function startAlwaysListening() {
  if (alwaysRec) return;
  try {
    const audioCfg = chatCfg && chatCfg.inputDevice ? { deviceId: { exact: chatCfg.inputDevice } } : true;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: audioCfg });
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const srcNode = ctx.createMediaStreamSource(stream);
    const sp = ctx.createScriptProcessor(4096, 1, 1);
    const rec = { stream, ctx, sp, sr: ctx.sampleRate, noiseFloor: 0.005, inSpeech: false, silSec: 0, uttChunks: [], uttSec: 0, closed: false };
    sp.onaudioprocess = onAlwaysChunk;
    srcNode.connect(sp);
    sp.connect(ctx.destination);
    alwaysRec = rec;
    console.log('[voice] 全程监听启动 sr=' + rec.sr + ' device=' + ((chatCfg && chatCfg.inputDevice) ? chatCfg.inputDevice.slice(0, 24) : '默认'));
    refreshIndicator();
  } catch (e) {
    console.log('[voice] 全程监听启动失败:', e && e.message);
    showBubble('（全程监听麦克风不可用）');
  }
}
function stopAlwaysListening() {
  const rec = alwaysRec;
  if (!rec) return;
  rec.closed = true;
  try { rec.stream.getTracks().forEach(t => t.stop()); } catch (e) {}
  try { rec.ctx.close(); } catch (e) {}
  alwaysRec = null;
  vadActive = false;
  refreshIndicator();
  console.log('[voice] 全程监听停止');
}
function updateAlwaysListening() {
  const always = !!(chatCfg && chatCfg.enabled && chatCfg.micMode === 'always');
  if (always) startAlwaysListening();
  else stopAlwaysListening();
}

function bindChat() {
  chatBubbleEl = document.getElementById('chat-bubble');
  chatBarEl = document.getElementById('chat-bar');
  chatInputEl = document.getElementById('chat-input');
  chatSendBtnEl = document.getElementById('chat-send-btn');
  chatMicBtnEl = document.getElementById('chat-mic-btn');
  micIndicatorEl = document.getElementById('mic-indicator');
  const micHold = () => !!(chatCfg && chatCfg.micMode === 'hold');
  chatSendBtnEl.addEventListener('click', sendChat);
  chatMicBtnEl.addEventListener('click', () => { if (!micHold()) toggleVoiceInput(); });
  chatMicBtnEl.addEventListener('pointerdown', e => {
    if (!micHold()) return;
    e.preventDefault();
    if (!micListening && !micStarting) toggleVoiceInput();
  });
  const stopHold = () => { if (micHold() && (micListening || micStarting)) stopMicAndTranscribe(); };
  window.addEventListener('pointerup', stopHold);
  window.addEventListener('pointercancel', stopHold);
  chatInputEl.addEventListener('keydown', e => {
    if (e.key === 'Enter') sendChat();
  });
  window.petAPI.on('chat-config-changed', cfg => {
    applyChatCfg({ ...chatCfg, ...cfg });
  });
}

function onResizeHandleDown(e) {
  e.stopPropagation();
  resizeDragging = true;
  resizeStart = { x: e.screenX, y: e.screenY, scale: state ? state.scale : 1 };
  try { resizeHandleEl.setPointerCapture(e.pointerId); } catch (err) {}
}

function onResizeHandleMove(e) {
  if (!resizeDragging || !resizeStart) return;
  const w = app ? app.renderer.width : 300;
  const h = app ? app.renderer.height : 300;
  const dx = e.screenX - resizeStart.x;
  const dy = e.screenY - resizeStart.y;
  const k = 1 + (dx / w + dy / h) * 0.6;
  const v = clamp(resizeStart.scale * k, 0.15, 3);
  state.scale = v;
  updateScaleLabel();
  window.petAPI.setScale(v);
}

function onResizeHandleUp() {
  resizeDragging = false;
}

function bindEvents() {
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', e => {
    e.preventDefault();
    window.petAPI.showContextMenu();
  });
  window.addEventListener('mouseleave', () => {
    if (!dragging && !resizeMode) setInteractive(false);
  });
  // 调整大小模式下点击窗口外（窗口失焦）→ 收起边框
  window.addEventListener('blur', () => {
    if (resizeMode && !resizeDragging) toggleResizeMode();
  });
  if (resizeHandleEl) {
    resizeHandleEl.addEventListener('pointerdown', onResizeHandleDown);
    resizeHandleEl.addEventListener('pointermove', onResizeHandleMove);
    resizeHandleEl.addEventListener('pointerup', onResizeHandleUp);
    resizeHandleEl.addEventListener('pointercancel', onResizeHandleUp);
  }
}

// ---------- 模型加载 ----------
function fitModel() {
  if (!model || !app || !holder) return;
  // 逻辑屏幕尺寸（autoDensity 下 renderer.width 是物理尺寸，screen 才是逻辑）
  const w = app.renderer.screen.width;
  const h = app.renderer.screen.height;
  if (!w || !h) return;
  // 按模型画布尺寸等比缩放并居中（锚点 0.5，模型原点即模型中心）
  // 精确修正由 calibrateRender() 完成后应用（applyCalibration）
  model.scale.set(1);
  model.x = 0;
  model.y = 0;
  const s = Math.min(w / model.width, h / model.height);
  holder.scale.set(s);
  holder.x = w / 2;
  holder.y = h / 2;
  const mw = model.width * s;
  const mh = model.height * s;
  bounds = { x: w / 2 - mw / 2, y: h / 2 - mh / 2, width: mw, height: mh };
}

// 读取当前渲染结果的非透明像素包围盒（画布物理坐标）
function readVisualBounds() {
  try {
    const gl = app.renderer.gl;
    const w = canvas.width;
    const h = canvas.height;
    const px = new Uint8Array(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y += 2) {
      for (let x = 0; x < w; x += 2) {
        if (px[(y * w + x) * 4 + 3] > 30) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return null;
    // GL readPixels 的 y 原点在底部，翻转到屏幕坐标
    return { x: minX, y: h - 1 - maxY, w: maxX - minX, h: maxY - minY };
  } catch (e) {
    console.warn('[pet] readPixels failed:', e && e.message);
    return null;
  }
}

// 计算模型人物在 JS 变换下的屏幕包围盒（不经过 core 渲染，作为期望参照）
function jsVisualBounds() {
  try {
    const im = model.internalModel;
    const core = im.coreModel;
    const count = im.drawDataCount || (core.getDrawableCount ? core.getDrawableCount() : 0);
    if (!count) return null;
    const b = new PIXI.Rectangle();
    let u = null;
    for (let i = 0; i < count; i++) {
      if (im.getDrawableBounds(i, b) && b.width > 0 && b.height > 0) {
        if (!u) u = b.clone();
        else u.enlarge(b);
      }
    }
    if (!u || !u.width || !u.height) return null;
    const jw = u.width * holder.scale.x;
    const jh = u.height * holder.scale.y;
    const jcx = holder.x + (u.x + u.width / 2 - model.width / 2) * holder.scale.x;
    const jcy = holder.y + (u.y + u.height / 2 - model.height / 2) * holder.scale.y;
    return { cx: jcx, cy: jcy, w: jw, h: jh };
  } catch (e) {
    console.warn('[pet] js bounds failed:', e && e.message);
    return null;
  }
}

// 校准：纯视觉反馈迭代。每轮读取实际渲染像素的包围盒，与目标（窗口 94%）对比，
// 直接调整 holder 的缩放与平移，收敛后记录 JS↔视觉 的换算关系供 hitTest 使用。
// 注意：app.renderer.width 在 autoDensity 下返回物理尺寸，readPixels 也是物理，
// 因此校准循环内统一使用物理坐标（canvas.width/height）。
async function calibrateRender() {
  calib = null;
  const res = app.renderer.resolution || 1;
  window.petAPI.setCalibrating(true); // 校准期间窗口隐形，避免可见的跳动
  try {
    for (let round = 1; round <= 5; round++) {
      await new Promise(r => setTimeout(r, 350));
      const js = jsVisualBounds();
      const vb = readVisualBounds();
      if (!js || !vb || !vb.w || !vb.h) {
        console.warn('[pet] calibrate round ' + round + ': no data js=' + !!js + ' vb=' + !!vb);
        continue;
      }
      // 视觉包围盒（物理）
      const vw = vb.w;
      const vh = vb.h;
      const vcx = vb.x + vb.w / 2;
      const vcy = vb.y + vb.h / 2;
      const w = canvas.width;
      const h = canvas.height;
      const Cx = w / 2;
      const Cy = h / 2;
      const ax = vw / js.w || 1; // 视觉物理/js逻辑 比值（用于平移换算）
      const ay = vh / js.h || 1;
      // 1) 先平移：让视觉中心移到窗口中心（基于本轮实测）
      holder.x += (Cx - vcx) / ax;
      holder.y += (Cy - vcy) / ay;
      // 2) 再缩放：视觉中心已在窗口中心，围绕 holder 原点（窗口中心）缩放不会偏移
      const k = Math.min((w * 0.94) / vw, (h * 0.94) / vh);
      holder.scale.set(holder.scale.x * k, holder.scale.y * k);
      console.log('[pet] calibrate round ' + round + ': visual=' + Math.round(vw) + 'x' + Math.round(vh) +
        ' center=(' + Math.round(vcx) + ',' + Math.round(vcy) + ') k=' + k.toFixed(3) +
        ' ax=' + ax.toFixed(3) + ' ay=' + ay.toFixed(3));
      const settled = Math.abs(k - 1) < 0.015 && Math.abs(vcx - Cx) < 1.5 && Math.abs(vcy - Cy) < 1.5;
      if (settled) break;
    }
    // 记录最终 JS↔视觉 换算（逻辑坐标），供 hitTest 与 bounds 使用
    const js2 = jsVisualBounds();
    const vb2 = readVisualBounds();
    if (js2 && vb2 && vb2.w && vb2.h) {
      const axf = (vb2.w / res) / js2.w;
      const ayf = (vb2.h / res) / js2.h;
      const txf = (vb2.x + vb2.w / 2) / res - axf * js2.cx;
      const tyf = (vb2.y + vb2.h / 2) / res - ayf * js2.cy;
      calib = { ax: axf, ay: ayf, tx: txf, ty: tyf };
      const vw = vb2.w / res;
      const vh = vb2.h / res;
      const vcx = (vb2.x + vb2.w / 2) / res;
      const vcy = (vb2.y + vb2.h / 2) / res;
      bounds = { x: vcx - vw / 2, y: vcy - vh / 2, width: vw, height: vh };
      console.log('[pet] calibration done: visual=' + Math.round(vw) + 'x' + Math.round(vh) +
        ' bounds=(' + Math.round(bounds.x) + ',' + Math.round(bounds.y) + ') calib ax=' + axf.toFixed(4) + ' ay=' + ayf.toFixed(4) +
        ' tx=' + Math.round(txf) + ' ty=' + Math.round(tyf));
      window.petAPI.setCalibrating(false);
      if (formName) applyExpressionPersistent(formName); // 模型加载完成后恢复形态
      return true;
    }
    window.petAPI.setCalibrating(false);
    return false;
  } catch (e) {
    window.petAPI.setCalibrating(false);
    throw e;
  }
}

// 视觉坐标 → JS 坐标（供 hitTest 使用）
function toJsPoint(x, y) {
  if (calib) return { x: (x - calib.tx) / calib.ax, y: (y - calib.ty) / calib.ay };
  // fallback：旧的 resolution 近似
  const res = app ? (app.renderer.resolution || 1) : 1;
  return { x: x / res, y: y / res };
}

async function loadModel(payload) {
  if (!payload || !payload.settings) {
    console.error('[pet] no model payload');
    if (state && state.smoke) window.petAPI.smokeResult(false, 'no model payload');
    return;
  }
  state.model = payload;
  model = null;
  if (holder) {
    try { holder.destroy({ children: true }); } catch (e) {} // 同时销毁旧模型
    holder = null;
  }
  bounds = null;
  sleeping = false;
  const settings = payload.settings;

  try {
    model = await Live2DModel.from(settings, {
      autoInteract: false,
      autoUpdate: false, // 改为手动更新（onTick 里），保证参数应用顺序：先模型更新、后我们的参数
      motionPreload: 'ALL',
      idleMotionGroup: 'Idle',
      backgroundAlpha: 0,
    });
  } catch (e) {
    console.error('[pet] model load failed:', e && (e.message || e));
    if (state && state.smoke) window.petAPI.smokeResult(false, 'model load failed: ' + (e && e.message));
    return;
  }
  model.anchor.set(0.5, 0.5); // 锚点设为中心，模型原点 = 模型中心
  // 关键修复：渲染库的模型更新函数每帧结尾调用 loadParameters()，
  // 把全部参数重置为初始化默认值（Cubism 4 时代的机制）。
  // 这导致 motion 和表情写入的参数每帧被清空（"无表情"的根因）。
  // Cubism 5 核心下无此必要，禁用它；显式恢复用保存的原函数。
  try {
    const core = model.internalModel.coreModel;
    if (!core.__origLoadParameters && typeof core.loadParameters === 'function') {
      core.__origLoadParameters = core.loadParameters.bind(core);
      core.loadParameters = () => {};
      console.log('[pet] per-frame loadParameters disabled (Cubism5 fix)');
    }
  } catch (e) {
    console.warn('[pet] disable loadParameters failed:', e && e.message);
  }
  // 关键：模型的动作参数更新发生在 PIXI 渲染阶段（internalModel.update 在 _render 内），
  // 而我们的参数必须在动作更新之后、绘制之前应用才能生效。
  // 因此把 applyParams 挂到 draw 上：每帧顺序 = 动作更新 → 我们的参数 → 绘制。
  if (!model.internalModel.__petDrawPatched) {
    model.internalModel.__petDrawPatched = true;
    const im = model.internalModel;
    const origDraw = im.draw.bind(im);
    im.draw = (gl) => {
      try {
        applyParams();
        // Cubism 5 核心的渲染管线需要在绘制前调用 native 模型更新来同步参数
        // （cubism4.min.js 是为 Cubism 4 写的，从不调用它；Cubism 5 必须）
        const core = model.internalModel.coreModel;
        if (core && core._model && typeof core._model.update === 'function') {
          core._model.update();
        }
      } catch (e) {
        console.warn('[pet] draw patch error:', e && e.message);
      }
      origDraw(gl);
    };
    console.log('[pet] draw patch applied (params applied after motion update)');
  }
  holder = new PIXI.Container();
  holder.addChild(model);
  if (state.diag) {
    app.stage.addChildAt(holder, 1); // 诊断模式：绿色背景(0) → 模型(1) → 品红前景(2)
  } else {
    app.stage.addChild(holder);
  }
  try {
    model.internalModel.motionManager.on('motionStart', (group) => {
      if (group === 'Sleep') sleeping = true;
      else if (sleeping && group !== 'Sleep') sleeping = false;
    });
    const em = model.internalModel.motionManager.expressionManager;
    if (em) {
      em.on('expressionLoadError', (index, err) => {
        console.warn('[pet] expression load error index=' + index + ':', err && (err.message || err));
      });
    }
    // Idle 循环动作每次重启都会重置表情（shouldOverrideExpression），
    // 导致点击表情闪现即没。禁用该行为，表情持续到我们自己的复位计时。
    try {
      const ms = model.internalModel.motionManager.state;
      if (ms && typeof ms.shouldOverrideExpression === 'function') {
        ms.shouldOverrideExpression = () => false;
        console.log('[pet] expression override disabled');
      }
    } catch (e) {}
    // 补上表达式每帧更新（渲染库的 updateParameters 只更新 motion，漏了 expression，
    // 导致表情参数不推进、切换时残留叠加）
    try {
      const mm = model.internalModel.motionManager;
      if (!mm.__petExprUpdatePatched && mm.expressionManager) {
        mm.__petExprUpdatePatched = true;
        const origUp = mm.updateParameters.bind(mm);
        mm.updateParameters = (m, now) => {
          const r = origUp(m, now);
          if (mm.expressionManager) {
            try { mm.expressionManager.updateParameters(m, now); } catch (e) {}
          }
          return r;
        };
        console.log('[pet] expression per-frame update patched');
      }
    } catch (e) {}
  } catch (e) {}
  fitModel();
  // 捕获默认参数快照（Idle 播放前，用于清除表情/动作残留）
  captureDefaultParams();
  // 自动校准渲染矩阵差异（Cubism 5 核心的缩放+平移），完成后模型精确居中适配
  setTimeout(async () => {
    try {
      const ok = await calibrateRender();
      if (!ok) console.warn('[pet] calibration failed, using fallback');
    } catch (e) {
      console.warn('[pet] calibration error:', e && e.message);
    }
  }, 200);
  // 上报实际宽高比，主进程据此调整窗口
  const iw = model.internalModel.originalWidth;
  const ih = model.internalModel.originalHeight;
  if (iw && ih) window.petAPI.reportAspect(iw / ih);
  // 启动待机动作（idleMotionGroup 只在动作结束后接管，需手动开始第一段）
  if (!playMotionGroup('Idle')) {
    const groups = Object.keys(model.internalModel.motionManager.definitions || {});
    playMotionGroup(pick(groups));
  }
  // 诊断：核心模型对象暴露的接口 + 参数名探测
  try {
    const core = model.internalModel.coreModel;
    console.log('[pet] core keys:', Object.keys(core).slice(0, 60).join(', '));
    const native = core._model;
    const pv = native && native.parameters && native.parameters.values;
    console.log('[pet] native param values:', pv ? ((pv.constructor && pv.constructor.name) + ' len=' + pv.length) : 'MISSING');
    // 底层直写验证（ParamEyeLOpen 索引 216）
    if (pv && pv.length > 216) {
      pv[216] = 1;
      const rb = core.getParameterValueById('ParamEyeLOpen');
      console.log('[pet] direct write test: raw readback=' + rb);
    }
    const candidates = [
      'ParamAngleX', 'ParamAngleY', 'ParamAngleZ', 'ParamEyeBallX', 'ParamEyeBallY',
      'ParamBodyAngleX', 'ParamBodyAngleY', 'ParamEyeLOpen', 'ParamEyeROpen',
      'ParamMouthOpenY', 'ParamMouthForm', 'ParamMouthSize', 'ParamBreath',
      'ParamBlush', 'ParamCRY', 'ParamDizzyEYE2',
    ];
    if (typeof core.getParameterIndex === 'function') {
      const hit = {};
      for (const p of candidates) hit[p] = core.getParameterIndex(p);
      console.log('[pet] param index probe:', JSON.stringify(hit));
      // 输出关键参数的值域（判断映射幅度是否合理）
      try {
        const mn = core._parameterMinimumValues;
        const mx = core._parameterMaximumValues;
        if (mn && mx) {
          for (const p of ['ParamAngleX', 'ParamAngleY', 'ParamAngleZ', 'ParamEyeLOpen', 'ParamEyeROpen', 'ParamMouthOpenY', 'ParamMouthForm']) {
            const i = hit[p];
            if (i >= 0) console.log('[pet] range', p, '=', mn[i], '..', mx[i]);
          }
        }
      } catch (e2) {}
    } else {
      console.log('[pet] core has no getParameterIndex');
    }
    if (typeof core.getParameterCount === 'function') {
      console.log('[pet] parameter count:', core.getParameterCount());
    }
  } catch (e) {
    console.warn('[pet] param probe failed:', e && e.message);
  }
  console.log('[pet] model loaded:', payload.name, 'canvas:', iw, 'x', ih);
}

// ---------- IPC ----------
function registerIpc() {
  window.petAPI.on('model-changed', payload => { loadModel(payload); });
  window.petAPI.on('resized', size => {
    if (!app || !size) return;
    app.renderer.resize(size.width, size.height);
    if (typeof size.scale === 'number') {
      state.scale = size.scale;
      updateScaleLabel();
    }
    fitModel();
    if (calib) {
      // 缩放窗口后重新校准（模型变换被重置）
      setTimeout(async () => {
        try { await calibrateRender(); } catch (e) {}
      }, 300);
    }
  });
  window.petAPI.on('toggle-resize-mode', () => { toggleResizeMode(); });
  window.petAPI.on('play-motion', kind => {
    if (!model) return;
    if (kind === 'random') {
      const groups = (state.model && state.model.motionGroups) || [];
      const prefer = groups.find(g => /^all$/i.test(g)) ||
        groups.find(g => !/idle|sleep/i.test(g)) ||
        groups[0];
      if (!prefer || !playMotionGroup(prefer)) tapReaction('body');
    }
  });
  window.petAPI.on('set-expression', name => setExpression(name));
  window.petAPI.on('set-form', name => setForm(name));
  window.petAPI.on('toggle-sleep', () => {
    if (sleeping) wakeUp();
    else goSleep();
  });
  window.petAPI.on('toggle-camera', () => { toggleCamera(); });
  // 全局鼠标跟随：鼠标不在窗口内时，模型也看向鼠标（主进程轮询全局位置）
  window.petAPI.on('global-mouse', pos => {
    if (!app || camActive || sleeping) return;
    const w = app.renderer.screen.width || 1;
    const h = app.renderer.screen.height || 1;
    const R = Math.max(w, h, 400) / 2 + 150; // 归一化半径：窗口外一定距离即到极限
    focus.tx = clamp(pos.x / R, -1, 1);
    focus.ty = clamp(pos.y / R, -1, 1);
  });
  window.petAPI.on('cam-preview-changed', v => {
    if (state) state.camPreview = v;
    if (camVideo) camVideo.style.display = v === false ? 'none' : '';
  });
  window.petAPI.on('cam-sens-changed', sens => {
    if (state) state.camSens = sens;
    console.log('[pet] cam sens updated:', JSON.stringify(sens));
  });
  window.petAPI.on('test-expression', () => {
    // 测试表情：设置最大强度表情参数（不碰姿态，3 秒后自动恢复默认）
    if (!model) return;
    try {
      const core = model.internalModel.coreModel;
      core.setParameterValueById('ParamBlush', 1);
      core.setParameterValueById('ParamSweat1', 40);
      core.setParameterValueById('ParamCRY', 60);
      console.log('[pet] test-expression: blush=' + core.getParameterValueById('ParamBlush') +
        ' sweat=' + core.getParameterValueById('ParamSweat1') +
        ' (3 秒后自动恢复)');
      setTimeout(() => {
        try { restoreDefaultParams(); } catch (e) {}
      }, 3000);
    } catch (e) {
      console.warn('[pet] test-expression failed:', e && e.message);
    }
  });
}

// ---------- 主循环 ----------
let diagFrameCount = 0;
function onTick(dt) {
  const dts = dt / 60; // PIXI v6 delta 单位为帧
  // 注意：applyParams 已挂到 internalModel.draw（动作更新后、绘制前），不在这里调用
  if (model) {
    try { model.update(app.ticker.deltaMS || dts * 1000); } catch (e) {}
  }
  updateFocus(dts);
  updateCamera(dts);
  if (state.diag && diagFrameCount < 8) {
    diagFrameCount++;
    const gl = app.renderer.gl;
    const vp = gl.getParameter(gl.VIEWPORT);
    const fbo = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    console.log('[pet] diag frame ' + diagFrameCount +
      ' gl.VIEWPORT=[' + vp[0] + ',' + vp[1] + ',' + vp[2] + ',' + vp[3] + ']' +
      ' fbo=' + fbo + ' canvas=' + canvas.width + 'x' + canvas.height +
      ' screen=' + app.renderer.screen.width + 'x' + app.renderer.screen.height);
  }
  if (firstFrame && model) {
    firstFrame = false;
    if (state.smoke) {
      setTimeout(() => window.petAPI.smokeResult(true, 'loaded: ' + (state.modelName || state.model.name)), 800);
    }
  }
}

// ---------- 启动 ----------
async function init() {
  canvas = document.getElementById('stage');
  resizeFrameEl = document.getElementById('resize-frame');
  resizeHandleEl = document.getElementById('resize-handle');
  resizeLabelEl = document.getElementById('resize-label');
  try {
    state = await window.petAPI.getState();
    formName = (state && state.formExpression) || '';
  } catch (e) {
    console.error('[pet] getState failed:', e);
    return;
  }
  try {
    // 渲染分辨率必须 = 系统 DPI（devicePixelRatio），不能更大：
    // Electron 透明窗口在 Windows 高 DPI 下，若 canvas 物理像素 > 窗口物理像素，
    // 合成器会把 canvas 左上角按 1:1 贴到窗口，其余区域丢失（"只显示左上角"）。
    // resolution = dpr 时 canvas 物理 = 窗口物理，恰好安全，且清晰度 = 原生 DPI。
    // 兼容模式（右键菜单可关）：resolution=1，画质降低但最保险。
    const dpr = window.devicePixelRatio || 1;
    const res = !state || state.quality !== 'compat' ? dpr : 1;
    app = new PIXI.Application({
      view: canvas,
      width: state.size.width,
      height: state.size.height,
      transparent: true,
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      preserveDrawingBuffer: true, // 校准需要读取渲染后的像素
      sharedTicker: true, // 与模型内部 ticker 共用，保证每帧更新顺序（模型先更新，我们再覆盖参数）
      resolution: res,
      clearBeforeRender: true,
    });
  } catch (e) {
    console.error('[pet] pixi init failed:', e && e.message);
    if (state.smoke) window.petAPI.smokeResult(false, 'pixi init failed: ' + (e && e.message));
    return;
  }
  // 视口单位修正：渲染主屏时 PIXI 某些路径会用「逻辑尺寸」设置 gl.viewport，
  // 而 canvas 物理缓冲 = 逻辑 x resolution，两者不匹配时整个场景会被裁剪到左上角
  // （分辨率越高裁剪越多，1x 时逻辑=物理所以正常）。
  // 拦截 setViewport：当传入的宽高等于逻辑 screen 尺寸（且不等于物理画布尺寸）时，
  // 自动换算为物理尺寸。
  (function patchViewportUnits() {
    try {
      const fsys = app.renderer.framebuffer;
      if (!fsys || !fsys.setViewport || fsys.__petViewportPatched) return;
      fsys.__petViewportPatched = true;
      const orig = fsys.setViewport.bind(fsys);
      fsys.setViewport = function (x, y, w, h) {
        const res = app.renderer.resolution || 1;
        const scr = app.renderer.screen;
        const isLogicalSize =
          scr &&
          Math.round(w) === Math.round(scr.width) &&
          Math.round(h) === Math.round(scr.height) &&
          Math.round(w) !== canvas.width;
        if (isLogicalSize) {
          if (!fsys.__petFixLogged) {
            fsys.__petFixLogged = true;
            console.log('[pet] viewport fix: logical ' + w + 'x' + h + ' -> physical ' + Math.round(w * res) + 'x' + Math.round(h * res) +
              ' (canvas=' + canvas.width + 'x' + canvas.height + ', resolution=' + res + ')');
          }
          x = Math.round(x * res);
          y = Math.round(y * res);
          w = Math.round(w * res);
          h = Math.round(h * res);
        }
        orig(x, y, w, h);
      };
      console.log('[pet] viewport units patch applied, resolution=' + app.renderer.resolution +
        ' canvas=' + canvas.width + 'x' + canvas.height + ' screen=' + app.renderer.screen.width + 'x' + app.renderer.screen.height);
    } catch (e) {
      console.warn('[pet] viewport patch failed:', e && e.message);
    }
  })();
  // 诊断日志（进 app.log）：排查渲染尺寸问题
  console.log('[pet] render info: dpr=' + (window.devicePixelRatio || 1) +
    ' canvas=' + canvas.width + 'x' + canvas.height +
    ' screen=' + app.renderer.screen.width + 'x' + app.renderer.screen.height +
    ' viewport=' + app.renderer.framebuffer.viewport.width + 'x' + app.renderer.framebuffer.viewport.height +
    ' resolution=' + app.renderer.resolution);
  bindEvents();
  registerIpc();
  bindChat();
  applyChatCfg(state.chat || null);
  app.ticker.add(onTick);
  if (state.diag) {
    // 诊断模式：模型前画绿色背景、模型后画品红前景。
    // 若品红铺满窗口 → 模型渲染后视口正常；若品红只出现在左上角小块 → 蒙版渲染残留了视口。
    const w = app.renderer.width;
    const h = app.renderer.height;
    const bg = new PIXI.Graphics();
    bg.beginFill(0x00ff00, 0.35).drawRect(0, 0, w, h).endFill();
    app.stage.addChild(bg);
    const fg = new PIXI.Graphics();
    fg.beginFill(0xff00ff, 0.45).drawRect(0, 0, w, h).endFill();
    app.stage.addChild(fg);
    console.log('[pet] diag mode: green=before model, magenta=after model');
  }
  if (state.model && state.model.settings) {
    await loadModel(state.model);
  } else {
    console.warn('[pet] 未找到模型。右键菜单 → 模型 → 添加模型…');
  }
}

window.addEventListener('DOMContentLoaded', init);
