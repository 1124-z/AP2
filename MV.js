/* MV.js —— 精简版《WebGL 编程指南》矩阵库（列主序 4x4）
   提供 mat4 基本变换：identity / translation / translate / rotationX(Y,Z) /
   rotateX(Y,Z) / scaling / scale / multiply / perspective / ortho / lookAt。
   约定：所有矩阵为 Float32Array(16)，列主序；
        multiply(m1, m2) = m1 * m2，即对顶点先施加 m2 再施加 m1（右乘 = 局部优先）。 */
"use strict";

const _d2r = Math.PI / 180;

function identity() {
    const m = new Float32Array(16);
    m[0] = m[5] = m[10] = m[15] = 1;
    return m;
}

function multiply(m1, m2) {            // 返回 m1 * m2（列主序）
    const r = new Float32Array(16);
    for (let c = 0; c < 4; c++) {
        for (let row = 0; row < 4; row++) {
            r[c * 4 + row] =
                m1[row]       * m2[c * 4]     +
                m1[4 + row]   * m2[c * 4 + 1] +
                m1[8 + row]   * m2[c * 4 + 2] +
                m1[12 + row]  * m2[c * 4 + 3];
        }
    }
    return r;
}

function translation(x, y, z) {
    const m = identity();
    m[12] = x; m[13] = y; m[14] = z;
    return m;
}
function translate(m, x, y, z) { return multiply(m, translation(x, y, z)); }

function rotationX(deg) {
    const r = deg * _d2r, c = Math.cos(r), s = Math.sin(r);
    const m = identity();
    m[5] = c; m[6] = s; m[9] = -s; m[10] = c;
    return m;
}
function rotationY(deg) {
    const r = deg * _d2r, c = Math.cos(r), s = Math.sin(r);
    const m = identity();
    m[0] = c; m[2] = -s; m[8] = s; m[10] = c;
    return m;
}
function rotationZ(deg) {
    const r = deg * _d2r, c = Math.cos(r), s = Math.sin(r);
    const m = identity();
    m[0] = c; m[1] = s; m[4] = -s; m[5] = c;
    return m;
}
function rotateX(m, deg) { return multiply(m, rotationX(deg)); }
function rotateY(m, deg) { return multiply(m, rotationY(deg)); }
function rotateZ(m, deg) { return multiply(m, rotationZ(deg)); }

function scaling(x, y, z) {
    const m = identity();
    m[0] = x; m[5] = y; m[10] = z;
    return m;
}
function scaleM(m, x, y, z) { return multiply(m, scaling(x, y, z)); }

function perspective(fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy * _d2r / 2);
    const m = new Float32Array(16);
    m[0] = f / aspect; m[5] = f;
    m[10] = (far + near) / (near - far);
    m[11] = -1;
    m[14] = 2 * far * near / (near - far);
    return m;
}

function ortho(left, right, bottom, top, near, far) {
    const m = identity();
    m[0] = 2 / (right - left);
    m[5] = 2 / (top - bottom);
    m[10] = -2 / (far - near);
    m[12] = -(right + left) / (right - left);
    m[13] = -(top + bottom) / (top - bottom);
    m[14] = -(far + near) / (far - near);
    return m;
}

function normalize3(v) {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
}
function cross3(a, b) {
    return [a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0]];
}
function dot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

function lookAt(eye, at, up) {
    const z = normalize3([eye[0] - at[0], eye[1] - at[1], eye[2] - at[2]]);
    const x = normalize3(cross3(up, z));
    const y = cross3(z, x);
    const m = identity();
    m[0] = x[0]; m[1] = x[1]; m[2] = x[2];
    m[4] = y[0]; m[5] = y[1]; m[6] = y[2];
    m[8] = z[0]; m[9] = z[1]; m[10] = z[2];
    m[12] = -dot3(x, eye); m[13] = -dot3(y, eye); m[14] = -dot3(z, eye);
    return m;
}

/* 四元数工具（虚拟轨迹球用）：[w, x, y, z] */
function quatAxisAngle(axis, angle) {
    const h = angle / 2, s = Math.sin(h);
    return [Math.cos(h), axis[0] * s, axis[1] * s, axis[2] * s];
}
function quatMul(a, b) {
    return [
        a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
        a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
        a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
        a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0]
    ];
}
function quatRotate(q, v) {
    const w = q[0], u = [q[1], q[2], q[3]];
    const uv = cross3(u, v);
    const uuv = cross3(u, uv);
    return [v[0] + 2 * (w * uv[0] + uuv[0]),
            v[1] + 2 * (w * uv[1] + uuv[1]),
            v[2] + 2 * (w * uv[2] + uuv[2])];
}
