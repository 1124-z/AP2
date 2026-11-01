"use strict";

/* ==================== 着色器 ==================== */
const PLANET_VS = `
attribute vec4 aPosition;
attribute vec3 aNormal;
attribute vec2 aTexCoord;
uniform mat4 uModel;
uniform mat4 uView;
uniform mat4 uProjection;
varying vec3 vNormal;
varying vec3 vWorldPos;
varying vec2 vTexCoord;
void main() {
    vec4 wp = uModel * aPosition;
    vWorldPos = wp.xyz;
    vNormal = mat3(uModel[0].xyz, uModel[1].xyz, uModel[2].xyz) * aNormal;
    vTexCoord = aTexCoord;
    gl_Position = uProjection * uView * wp;
}`;

const PLANET_FS = `
precision mediump float;
varying vec3 vNormal;
varying vec3 vWorldPos;
varying vec2 vTexCoord;
uniform sampler2D uSampler;
uniform bool uUseTexture;
uniform bool uEmissive;
uniform vec4 uColor;
uniform vec3 uSunPos;
void main() {
    vec3 base = uColor.rgb;
    if (uUseTexture) base = texture2D(uSampler, vTexCoord).rgb;
    if (uEmissive) { gl_FragColor = vec4(base, 1.0); return; }
    vec3 N = normalize(vNormal);
    vec3 L = normalize(uSunPos - vWorldPos);
    float diff  = max(dot(N,  L), 0.0);
    float back  = max(dot(-N, L), 0.0) * 0.35;   /* 环等薄片背面也受光 */
    vec3 col = base * (0.28 + 0.85 * diff + back);
    gl_FragColor = vec4(col, uColor.a);
}`;

const FLAT_VS = `
attribute vec4 aPosition;
uniform mat4 uMVP;
void main() { gl_Position = uMVP * aPosition; gl_PointSize = 2.5; }`;

const FLAT_FS = `
precision mediump float;
uniform vec4 uColor;
void main() { gl_FragColor = uColor; }`;

/* ==================== 天体参数（集中配置） ==================== */
/* radius: 视觉半径; dist: 轨道半径; period: 公转周期(年, 用于角速度);
   day: 自转周期(天, 负值 = 逆向自转); tilt: 轴倾角(度);
   orbit0: 初始相位; color: 纹理加载失败时的回退色 */
const SUN = { radius: 18, spinDays: 27, tex: 'sun' };
const MOON = { radius: 3, dist: 12, periodDays: 27.3, tex: 'moon', color: [0.85, 0.85, 0.85, 1] };
const MOON_ORBIT_TILT = 5.14;   /* 月球轨道面相对黄道的倾角 —— 用“手造矩阵”实现 */

const PLANETS = [
    { name: 'mercury', radius: 2.2, dist: 40,  period: 0.24, day: 58.6,  tilt: 0.03,  orbit0: 1.0, color: [0.71, 0.65, 0.55, 1] },
    { name: 'venus',   radius: 3.8, dist: 60,  period: 0.62, day: 243,   tilt: 177.4, orbit0: 2.5, color: [0.88, 0.78, 0.55, 1] },
    { name: 'earth',   radius: 4.0, dist: 85,  period: 1.0,  day: 1.0,   tilt: 23.5,  orbit0: 0.6, color: [0.29, 0.56, 0.85, 1] },
    { name: 'mars',    radius: 3.0, dist: 110, period: 1.9,  day: 1.03,  tilt: 25.2,  orbit0: 3.4, color: [0.85, 0.42, 0.26, 1] },
    { name: 'jupiter', radius: 11,  dist: 160, period: 12,   day: 0.41,  tilt: 3.1,   orbit0: 5.1, color: [0.85, 0.69, 0.52, 1] },
    { name: 'saturn',  radius: 9.5, dist: 210, period: 29,   day: 0.45,  tilt: 26.7,  orbit0: 2.2, color: [0.90, 0.82, 0.60, 1], ring: true },
    { name: 'uranus',  radius: 6.5, dist: 260, period: 84,   day: -0.72, tilt: 97.8,  orbit0: 4.0, color: [0.60, 0.86, 0.88, 1] },
    { name: 'neptune', radius: 6.3, dist: 310, period: 165,  day: 0.67,  tilt: 28.3,  orbit0: 0.2, color: [0.31, 0.44, 0.85, 1] },
];
const EARTH = PLANETS[2];
const BELT = { inner: 122, outer: 148, count: 700, height: 6 };
const RING = { inner: 1.24, outer: 2.27, alpha: 0.95 };

/* 面板全局状态 */
let orbitSpeedF = 1.0, spinSpeedF = 1.0, tiltDeg = 23.5;
let showOrbits = true, showBelt = true;
let perspectiveMode = true;

/* ==================== 手造矩阵：月球轨道倾角 ====================
   按教材 Ch4 的推导，绕 X 轴旋转 θ 的矩阵（行主序写法）：
       [ 1   0    0   0 ]
       [ 0  cosθ -sinθ 0 ]
       [ 0  sinθ  cosθ 0 ]
       [ 0   0    0   1 ]
   WebGL 使用列主序存储，逐元素写出即得下方数组。
   不使用 rotate() 复合函数，直接以 sin/cos 构造 —— 对应量规“手动矩阵”。 */
function manualTiltMatrixX(deg) {
    const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
    return new Float32Array([          /* 列 0    列 1    列 2    列 3 */
        1, 0, 0, 0,                      /* 第 0 行：1 0   0    0 */
        0, c, s, 0,                      /* 第 1 行：0 c  -s? 见 README 推导 */
        0, -s, c, 0,
        0, 0, 0, 1
    ]);
}

/* ==================== WebGL 初始化 ==================== */
const canvas = document.getElementById('gl-canvas');
const gl = canvas.getContext('webgl', { antialias: true });
if (!gl) alert('当前浏览器不支持 WebGL');

function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

function compileShader(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
        console.error(gl.getShaderInfoLog(s));
    return s;
}
function makeProgram(vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, compileShader(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compileShader(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS))
        console.error(gl.getProgramInfoLog(p));
    return p;
}

const progPlanet = makeProgram(PLANET_VS, PLANET_FS);
const progFlat = makeProgram(FLAT_VS, FLAT_FS);
const P = {
    aPos: gl.getAttribLocation(progPlanet, 'aPosition'),
    aNrm: gl.getAttribLocation(progPlanet, 'aNormal'),
    aUv: gl.getAttribLocation(progPlanet, 'aTexCoord'),
    uModel: gl.getUniformLocation(progPlanet, 'uModel'),
    uView: gl.getUniformLocation(progPlanet, 'uView'),
    uProj: gl.getUniformLocation(progPlanet, 'uProjection'),
    uSampler: gl.getUniformLocation(progPlanet, 'uSampler'),
    uUseTex: gl.getUniformLocation(progPlanet, 'uUseTexture'),
    uEmis: gl.getUniformLocation(progPlanet, 'uEmissive'),
    uColor: gl.getUniformLocation(progPlanet, 'uColor'),
    uSunPos: gl.getUniformLocation(progPlanet, 'uSunPos'),
};
const F = {
    aPos: gl.getAttribLocation(progFlat, 'aPosition'),
    uMVP: gl.getUniformLocation(progFlat, 'uMVP'),
    uColor: gl.getUniformLocation(progFlat, 'uColor'),
};

/* ==================== 几何体 ==================== */
function makeVAO(pos, nrm, uv, idx) {
    const vao = {
        pos: gl.createBuffer(), nrm: gl.createBuffer(),
        uv: gl.createBuffer(), idx: gl.createBuffer(), count: idx.length
    };
    gl.bindBuffer(gl.ARRAY_BUFFER, vao.pos); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(pos), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, vao.nrm); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(nrm), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, vao.uv); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(uv), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, vao.idx); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(idx), gl.STATIC_DRAW);
    return vao;
}

function createSphere(latBands = 30, lonBands = 30) {
    const pos = [], nrm = [], uv = [], idx = [];
    for (let lat = 0; lat <= latBands; lat++) {
        const theta = lat * Math.PI / latBands;          /* θ=0 北极 */
        const sinT = Math.sin(theta), cosT = Math.cos(theta);
        for (let lon = 0; lon <= lonBands; lon++) {
            const phi = lon * 2 * Math.PI / lonBands;
            const x = sinT * Math.cos(phi), y = cosT, z = sinT * Math.sin(phi);
            pos.push(x, y, z); nrm.push(x, y, z);
            uv.push(lon / lonBands, 1.0 - lat / latBands);
        }
    }
    for (let lat = 0; lat < latBands; lat++)
        for (let lon = 0; lon < lonBands; lon++) {
            const a = lat * (lonBands + 1) + lon, b = a + lonBands + 1;
            idx.push(a, b, a + 1, b, b + 1, a + 1);
        }
    return makeVAO(pos, nrm, uv, idx);
}

function createOrbitCircle(segments = 128) {
    const pos = [], nrm = [], uv = [];
    for (let i = 0; i < segments; i++) {
        const t = i * 2 * Math.PI / segments;
        pos.push(Math.cos(t), Math.sin(t), 0); nrm.push(0, 0, 1); uv.push(0, 0);
    }
    return { vao: makeVAO(pos, nrm, uv, []), mode: gl.LINE_LOOP, count: segments, indexed: false };
}

function createRing(inner, outer, seg = 96) {   /* xy 平面上的三角带环，用 rotateX(90°) 放平 */
    const pos = [], nrm = [], uv = [], idx = [];
    for (let i = 0; i <= seg; i++) {
        const t = i * 2 * Math.PI / seg, c = Math.cos(t), s = Math.sin(t);
        pos.push(inner * c, inner * s, 0, outer * c, outer * s, 0);
        nrm.push(0, 0, 1, 0, 0, 1); uv.push(0, 0, 1, 0);
    }
    for (let i = 0; i < seg; i++) {
        const a = i * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    return makeVAO(pos, nrm, uv, idx);
}

function createBeltPoints() {
    const rng = (() => { let s = 20251031; return () => (s = (s * 16807) % 2147483647) / 2147483647; })();
    const pts = [];
    for (let i = 0; i < BELT.count; i++) {
        const r = BELT.inner + (BELT.outer - BELT.inner) * rng();
        const a = rng() * 2 * Math.PI;
        pts.push(r * Math.cos(a), (rng() - 0.5) * 2 * BELT.height, r * Math.sin(a));
    }
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(pts), gl.STATIC_DRAW);
    return { buf: buf, count: BELT.count };
}

const sphereGeo = createSphere();
const orbitGeo = createOrbitCircle();
const ringGeo = createRing(RING.inner, RING.outer);
const beltGeo = createBeltPoints();

/* ==================== 纹理 ==================== */
const TEX_FILES = {
    sun: 'textures/sun.png', mercury: 'textures/mercury.png', venus: 'textures/venus.png',
    earth: 'textures/earth.png', mars: 'textures/mars.png', jupiter: 'textures/jupiter.png',
    saturn: 'textures/saturn.png', uranus: 'textures/uranus.png', neptune: 'textures/neptune.png',
    moon: 'textures/moon.png'
};
const textures = {};

function fallbackTexture(rgba) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(rgba));
    return tex;
}

function loadTexture(url, fallbackRGBA) {
    return new Promise(resolve => {
        const img = new Image();
        img.onload = () => {
            const tex = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, tex);
            /* 地球等贴图上下颠倒问题：浏览器解码后的图像数据首行是“图片顶部”，
               而纹理坐标 v=0 对应首行上传数据 → 球体 v=0 在顶部会让贴图倒置。
               设置 UNPACK_FLIP_Y_WEBGL 在 texImage2D 时翻转 Y，即可“图顶对球顶”。 */
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            resolve(tex);
        };
        img.onerror = () => resolve(fallbackTexture(fallbackRGBA));
        img.src = url;
    });
}

/* ==================== 相机：轨迹球 + 漫游 ==================== */
const camera = {
    eye: [0, 140, 430], at: [0, 0, 0], up: [0, 1, 0],
    roaming: true, blend: 1, fromEye: null, blendStart: 0
};

/* 漫游路径：绕场景一周的参数曲线（含半径 / 高度的正弦起伏，处处光滑） */
function roamPos(t) {
    const a = t * 0.22;
    const R = 360 + 70 * Math.sin(t * 0.13);
    const h = 130 + 90 * Math.sin(t * 0.09 + 1.7);
    return [R * Math.cos(a), h, R * Math.sin(a)];
}

function updateCamera(now) {
    if (camera.roaming) {
        if (camera.blend < 1) {   /* 接管后重新开启漫游时，用 1.6s 平滑过渡回路径 */
            camera.blend = Math.min((now - camera.blendStart) / 1.6, 1);
            const s = camera.blend * camera.blend * (3 - 2 * camera.blend);
            const tp = roamPos(now);
            camera.eye = [
                camera.fromEye[0] + (tp[0] - camera.fromEye[0]) * s,
                camera.fromEye[1] + (tp[1] - camera.fromEye[1]) * s,
                camera.fromEye[2] + (tp[2] - camera.fromEye[2]) * s];
        } else {
            camera.eye = roamPos(now);
        }
        camera.up = [0, 1, 0];
    }
}

/* 虚拟轨迹球（E3）：把鼠标位置映射到单位球面，取相邻两点旋转 */
function arcballVec(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    const nx = ((clientX - r.left) / r.width) * 2 - 1;
    const ny = 1 - ((clientY - r.top) / r.height) * 2;
    const l2 = nx * nx + ny * ny;
    const v = l2 <= 1 ? [nx, ny, Math.sqrt(1 - l2)]
                      : normalize3([nx, ny, 0]);
    return v;
}

let dragging = false, lastP = null;
let isPanning = false; // 【新增】用于区分是“旋转”还是“平移”

// 屏蔽右键菜单，防止右键拖拽时弹出菜单
canvas.addEventListener('contextmenu', e => e.preventDefault());

canvas.addEventListener('mousedown', e => {
    dragging = true; 
    
    // 如果按的是右键，或者按住 Shift 键+左键，则进入平移模式
    if (e.button === 2 || e.shiftKey) {
        isPanning = true;
        canvas.style.cursor = 'move';
    } else {
        isPanning = false;
        lastP = arcballVec(e.clientX, e.clientY);
        canvas.classList.add('dragging');
    }
    
    if (camera.roaming) { camera.roaming = false; updateStatus(); }
});

window.addEventListener('mouseup', () => { 
    dragging = false; 
    isPanning = false;
    lastP = null; 
    canvas.classList.remove('dragging'); 
    canvas.style.cursor = 'default';
});

window.addEventListener('mousemove', e => {
    if (!dragging) return;

    if (isPanning) {
        // ================= 平移逻辑 =================
        // 根据视角算出当前屏幕的“右方向”和“上方向”
        const z = normalize3([camera.eye[0] - camera.at[0], camera.eye[1] - camera.at[1], camera.eye[2] - camera.at[2]]);
        const x = normalize3(cross3(camera.up, z)); // 屏幕右
        const y = cross3(z, x);                     // 屏幕上

        // 平移速度与相机距离成正比（离得越远，拖拽移动的跨度越大）
        const dist = Math.hypot(camera.eye[0] - camera.at[0], camera.eye[1] - camera.at[1], camera.eye[2] - camera.at[2]);
        const panSpeed = dist * 0.0015; 

        // 计算鼠标移动的增量（往左拖，场景往右滑）
        const dx = e.movementX || 0;
        const dy = e.movementY || 0;

        // 将位移应用到相机的 eye 和 at 上，保持相对位置不变
        camera.eye = [
            camera.eye[0] - x[0] * dx * panSpeed + y[0] * dy * panSpeed,
            camera.eye[1] - x[1] * dx * panSpeed + y[1] * dy * panSpeed,
            camera.eye[2] - x[2] * dx * panSpeed + y[2] * dy * panSpeed
        ];
        camera.at = [
            camera.at[0] - x[0] * dx * panSpeed + y[0] * dy * panSpeed,
            camera.at[1] - x[1] * dx * panSpeed + y[1] * dy * panSpeed,
            camera.at[2] - x[2] * dx * panSpeed + y[2] * dy * panSpeed
        ];
    } else {
        // ================= 旋转逻辑（原轨迹球） =================
        const p = arcballVec(e.clientX, e.clientY);
        const axis = cross3(lastP, p);
        const s = Math.hypot(axis[0], axis[1], axis[2]);
        if (s > 1e-6) {
            const ang = Math.acos(Math.max(-1, Math.min(1, dot3(lastP, p))));
            const q = quatAxisAngle([axis[0] / s, axis[1] / s, axis[2] / s], ang);
            camera.eye = quatRotate(q, camera.eye);
            camera.up = quatRotate(q, camera.up);
            if (camera.roaming) { camera.roaming = false; updateStatus(); }
        }
        lastP = p;
    }
});

canvas.addEventListener('wheel', e => {
    e.preventDefault();   // 阻止页面滚动

    // 计算当前相机到目标的距离
    const dx = camera.eye[0] - camera.at[0];
    const dy = camera.eye[1] - camera.at[1];
    const dz = camera.eye[2] - camera.at[2];
    const dist = Math.hypot(dx, dy, dz);

    // 缩放系数：向上滚（deltaY < 0）拉近，向下滚拉远
    const zoomFactor = Math.exp(e.deltaY * 0.001);  // 平滑指数缩放
    let newDist = dist * zoomFactor;

    // 限制距离范围，防止穿模或飞太远
    newDist = Math.max(30, Math.min(newDist, 1200));

    // 沿视线方向移动 eye（at 不动，实现"朝目标缩放"）
    const k = newDist / dist;
    camera.eye = [
        camera.at[0] + dx * k,
        camera.at[1] + dy * k,
        camera.at[2] + dz * k
    ];

    // 手动操作后停止漫游（如果需要）
    if (camera.roaming) { camera.roaming = false; updateStatus(); }
}, { passive: false });

/* ==================== 交互与面板 ==================== */
const $ = id => document.getElementById(id);
function updateStatus() {
    $('status').innerHTML =
        '投影：<b>' + (perspectiveMode ? '透视' : '正交') + '</b>（按 O 切换）<br>' +
        '漫游：<b>' + (camera.roaming ? '进行中' : '已暂停/手动') + '</b>（空格 暂停/继续）';
}
window.addEventListener('keydown', e => {
    if (e.key === ' ') { e.preventDefault(); toggleRoam(); }
    else if (e.key === 'o' || e.key === 'O') { perspectiveMode = !perspectiveMode; updateStatus(); }
});
function toggleRoam() {
    camera.roaming = !camera.roaming;
    if (camera.roaming) { camera.blend = 0; camera.fromEye = camera.eye.slice(); camera.blendStart = lastNow; }
    updateStatus();
}
$('orbSpeed').addEventListener('input', e => { orbitSpeedF = +e.target.value; $('orbVal').textContent = orbitSpeedF.toFixed(1) + 'x'; });
$('spinSpeed').addEventListener('input', e => { spinSpeedF = +e.target.value; $('spinVal').textContent = spinSpeedF.toFixed(1) + 'x'; });
$('tiltDeg').addEventListener('input', e => { tiltDeg = +e.target.value; $('tiltVal').textContent = tiltDeg.toFixed(1) + '°'; });
$('showOrbits').addEventListener('change', e => { showOrbits = e.target.checked; });
$('showBelt').addEventListener('change', e => { showBelt = e.target.checked; });

/* ==================== 动画状态 ==================== */
let sunSpin = 0, moonOrbit = 1.3, moonSpin = 0, beltAngle = 0;
for (const p of PLANETS) { p.orbit = p.orbit0; p.spin = 0; }

function updateAngles(dt) {
    const TWO_PI = Math.PI * 2;
    sunSpin += dt * spinSpeedF * (TWO_PI / 8) / Math.sqrt(SUN.spinDays);
    moonOrbit += dt * orbitSpeedF * TWO_PI / 3;
    moonSpin += dt * spinSpeedF * (TWO_PI / 8) / Math.sqrt(MOON.periodDays);
    beltAngle += dt * orbitSpeedF * 0.02;
    for (const p of PLANETS) {
        p.orbit += dt * orbitSpeedF * (TWO_PI / 20) / Math.pow(p.period, 0.6);
        p.spin += dt * spinSpeedF * (TWO_PI / 8) / Math.sqrt(Math.abs(p.day)) * Math.sign(p.day);
    }
}

/* ==================== 投影矩阵 ==================== */
function currentProjection() {
    const aspect = canvas.width / canvas.height;
    if (perspectiveMode) return perspective(45, aspect, 1, 2500);
    const halfH = 170, halfW = halfH * aspect;
    return ortho(-halfW, halfW, -halfH, halfH, 1, 2500);
}

/* ==================== 绘制 ==================== */
function bindPlanetGeo(vao) {
    gl.bindBuffer(gl.ARRAY_BUFFER, vao.pos);
    gl.vertexAttribPointer(P.aPos, 3, gl.FLOAT, false, 0, 0); gl.enableVertexAttribArray(P.aPos);
    gl.bindBuffer(gl.ARRAY_BUFFER, vao.nrm);
    gl.vertexAttribPointer(P.aNrm, 3, gl.FLOAT, false, 0, 0); gl.enableVertexAttribArray(P.aNrm);
    gl.bindBuffer(gl.ARRAY_BUFFER, vao.uv);
    gl.vertexAttribPointer(P.aUv, 2, gl.FLOAT, false, 0, 0); gl.enableVertexAttribArray(P.aUv);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, vao.idx);
}

function drawSphere(model, tex, emissive, fallbackColor, V, Pj) {
    gl.useProgram(progPlanet);
    gl.uniformMatrix4fv(P.uModel, false, model);
    gl.uniformMatrix4fv(P.uView, false, V);
    gl.uniformMatrix4fv(P.uProj, false, Pj);
    gl.uniform3fv(P.uSunPos, [0, 0, 0]);

    // 自发光标志：太阳为 true，其他星球为 false
    gl.uniform1i(P.uEmis, emissive ? 1 : 0);

    // 关键修复：纹理绑定对 emissive 和普通星球一视同仁
    if (tex) {
        gl.uniform1i(P.uUseTex, 1);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.uniform1i(P.uSampler, 0);
    } else {
        gl.uniform1i(P.uUseTex, 0);
        gl.uniform4fv(P.uColor, fallbackColor);
    }

    bindPlanetGeo(sphereGeo);
    gl.drawElements(gl.TRIANGLES, sphereGeo.count, gl.UNSIGNED_SHORT, 0);
}

function drawRing(model, V, Pj) {
    gl.useProgram(progPlanet);
    gl.uniformMatrix4fv(P.uModel, false, model);
    gl.uniformMatrix4fv(P.uView, false, V);
    gl.uniformMatrix4fv(P.uProj, false, Pj);
    gl.uniform3fv(P.uSunPos, [0, 0, 0]);
    gl.uniform1i(P.uUseTex, 0); gl.uniform1i(P.uEmis, 0);
    gl.uniform4fv(P.uColor, [0.83, 0.76, 0.58, RING.alpha]);
    bindPlanetGeo(ringGeo);
    gl.drawElements(gl.TRIANGLES, ringGeo.count, gl.UNSIGNED_SHORT, 0);
}

function drawFlat(vaoOrBuf, model, color, V, Pj, isPoints) {
    gl.useProgram(progFlat);
    const mvp = multiply(Pj, multiply(V, model));
    gl.uniformMatrix4fv(F.uMVP, false, mvp);
    gl.uniform4fv(F.uColor, color);
    if (isPoints) {
        gl.bindBuffer(gl.ARRAY_BUFFER, vaoOrBuf.buf);
        gl.vertexAttribPointer(F.aPos, 3, gl.FLOAT, false, 0, 0);
        gl.enableVertexAttribArray(F.aPos);
        gl.drawArrays(gl.POINTS, 0, vaoOrBuf.count);
        } else {
        const g = vaoOrBuf;
        gl.bindBuffer(gl.ARRAY_BUFFER, g.vao.pos);
        gl.vertexAttribPointer(F.aPos, 3, gl.FLOAT, false, 0, 0);
        gl.enableVertexAttribArray(F.aPos);
        if (g.indexed === false) {
            gl.drawArrays(g.mode, 0, g.count);
        } else {
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, g.vao.idx);
            gl.drawElements(g.mode, g.count, gl.UNSIGNED_SHORT, 0);
        }
    }
}

function draw(V, Pj) {
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0.024, 0.04, 0.094, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);

    /* ---- 太阳：M_sun = R_y(θ_sun)·S(r_sun)，自转 + 自发光贴图 ---- */
    let mSun = multiply(rotationY(sunSpin), scaling(SUN.radius, SUN.radius, SUN.radius));
    drawSphere(mSun, textures.sun, true, null, V, Pj);

    /* ---- 行星 + 月球 ---- */
    for (const p of PLANETS) {
        /* 轨道节点：先沿 x 平移 dist，再绕 y 公转（等价于“挂在轨道上转”） */
        const node = multiply(rotationY(p.orbit), translation(p.dist, 0, 0));

        /* 地球轴倾角：先做自身 R_x(倾角)·R_y(自转)，再挂到轨道节点上 ——
           顺序反过来（R_x 乘在最外层）会让地轴方向随公转扫动，无法保持空间定向 */
        const tilt = (p.name === 'earth') ? tiltDeg : p.tilt;
        let m = multiply(node, rotationX(tilt));
        m = multiply(m, rotationY(p.spin));
        m = multiply(m, scaling(p.radius, p.radius, p.radius));
        drawSphere(m, textures[p.name], false, p.color, V, Pj);

        /* 土星环：继承土星节点的位置（与赤道面一致），旋转 90° 放平 */
        if (p.ring) {
            let mr = multiply(node, rotationX(90));
            mr = multiply(mr, scaling(p.radius, p.radius, p.radius));
            drawRing(mr, V, Pj);
        }

        /* 月球：轨道节点 = 地球轨道节点 · 手造倾角矩阵 · R_y(月相角) · T(d_m,0,0) */
        if (p.name === 'earth') {
            const moonNode = multiply(node, manualTiltMatrixX(MOON_ORBIT_TILT));
            let mm = multiply(moonNode, rotationY(moonOrbit));
            mm = multiply(mm, translation(MOON.dist, 0, 0));
            mm = multiply(mm, rotationY(moonSpin));
            mm = multiply(mm, scaling(MOON.radius, MOON.radius, MOON.radius));
            drawSphere(mm, textures.moon, false, MOON.color, V, Pj);
        }

        /* 轨道线 */
        if (showOrbits) {
            const mo = multiply(rotationX(90), scaling(p.dist, p.dist, p.dist));
            drawFlat(orbitGeo, mo, [0.35, 0.42, 0.62, 1], V, Pj, false);
        }
    }

    /* 月球轨道线（随地球移动；含手造倾角） */
    if (showOrbits) {
        const ea = EARTH.orbit * Math.PI / 180;
        const ex = EARTH.dist * Math.cos(ea), ez = -EARTH.dist * Math.sin(ea);
        const mo = multiply(translation(ex, 0, ez),
                    multiply(manualTiltMatrixX(MOON_ORBIT_TILT), rotationX(90)));
        drawFlat(orbitGeo, multiply(mo, scaling(MOON.dist, MOON.dist, MOON.dist)),
                 [0.66, 0.66, 0.78, 1], V, Pj, false);
    }

    /* 小行星带（E1） */
    if (showBelt) drawFlat(beltGeo, rotationY(beltAngle), [0.55, 0.52, 0.48, 1], V, Pj, true);
}

/* ==================== 主循环 ==================== */
let lastNow = 0;
function frame(ts) {
    const now = ts / 1000;
    const dt = Math.min(now - lastNow, 0.05);
    lastNow = now;
    updateAngles(dt);
    updateCamera(now);
    draw(lookAt(camera.eye, camera.at, camera.up), currentProjection());
    requestAnimationFrame(frame);
}

/* 纹理加载完成后启动 */
const jobs = Object.entries(TEX_FILES).map(([k, url]) => {
    const fb = (k === 'sun') ? [255, 200, 90, 255] : [150, 150, 150, 255];
    return loadTexture(url, fb).then(t => { textures[k] = t; });
});
Promise.all(jobs).then(() => {
    updateStatus();
    requestAnimationFrame(frame);
});
