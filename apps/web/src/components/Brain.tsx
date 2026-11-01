import { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { Bloom, EffectComposer, Vignette } from '@react-three/postprocessing';
import * as THREE from 'three';
import { REGIONS } from '@cortex/core';
import { loadBrain, type BrainGeometry } from '../lib/brain.ts';
import { REGION_META } from '../lib/regions.ts';
import { act, decay, mem, useUI } from '../lib/neural.ts';

const N = REGIONS.length;
const colors = REGIONS.map((r) => new THREE.Color(REGION_META[r].color));

const COMMON = /* glsl */ `
uniform float uTime;
uniform float uAct[${N}];
uniform vec3 uCol[${N}];
const vec3 GREY = vec3(0.46, 0.51, 0.62); // inactive regions are neutral; colour only appears where there is activity
float lit(float a) { return smoothstep(0.08, 0.55, a); }
`;

const pointsVert = /* glsl */ `
${COMMON}
uniform float uMem[${N}];
uniform float uPx;
uniform float uFocus;
attribute float aReg;
attribute float aPhase;
attribute float aSize;
varying vec3 vCol;
varying float vB;
varying float vSoma;
varying float vFire;
void main() {
  int r = int(aReg + 0.5);
  float a = 1.0 - exp(-uAct[r] * 1.3); // soft saturation: busy regions glow, never blow out
  float deep = (r == 5 || r == 7) ? 1.0 : 0.0; // hippocampus & amygdala sit deep: keep them visible
  // slow, broad twinkle (no strobing): each neuron breathes at its own gentle rate
  float spd = 0.35 + fract(aPhase * 13.0) * 0.9;
  float f = pow(max(0.0, sin(uTime * spd + aPhase * 6.2831)), 6.0);
  float fire = f * (0.04 + a * 0.55);
  // a minority of neurons are large "soma" cells: bigger, brighter, and they flare when they fire
  float soma = smoothstep(2.3, 2.9, aSize);
  float b = 0.05 + soma * 0.10 + deep * 0.03 + uMem[r] * 0.05 + a * 0.14 + fire * 0.35;
  if (uFocus >= 0.0 && int(uFocus + 0.5) != r) b *= 0.25;
  vB = b;
  vSoma = soma;
  vFire = clamp(fire * 2.2 + a * 0.5, 0.0, 1.0);
  vCol = mix(GREY, uCol[r], lit(a));
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float px = aSize * (1.0 + deep * 0.2) * uPx * (1.0 + fire * 0.4 + a * 0.1) / -mv.z;
  gl_PointSize = max(1.8, px * (0.6 + soma * 0.7));
  gl_Position = projectionMatrix * mv;
}`;

const pointsFrag = /* glsl */ `
varying vec3 vCol;
varying float vB;
varying float vSoma;
varying float vFire;
void main() {
  vec2 p = gl_PointCoord - 0.5;
  float d = length(p);
  if (d > 0.5) discard;
  float core = smoothstep(0.2, 0.0, d);                 // crisp bright nucleus
  float halo = pow(smoothstep(0.5, 0.0, d), 4.0);       // tight glow around it
  // four-point flare on large cells that are firing
  float flare = vSoma * vFire * (
      max(0.0, 1.0 - abs(p.x) * 16.0) * max(0.0, 1.0 - abs(p.y) * 2.2) +
      max(0.0, 1.0 - abs(p.y) * 16.0) * max(0.0, 1.0 - abs(p.x) * 2.2));
  vec3 hot = mix(vCol, vec3(1.0), 0.4);
  vec3 col = vCol * (halo * vB * 0.5 + flare * 0.9) + hot * core * (0.12 + vB * 1.0);
  gl_FragColor = vec4(col, clamp(max(core, halo * 0.8) + flare * 0.5, 0.0, 1.0));
}`;

const linesVert = /* glsl */ `
${COMMON}
uniform float uFocus;
attribute float aT;
attribute float aPhase;
attribute vec2 aReg;
varying float vT;
varying float vPhase;
varying float vAct;
varying vec3 vCol;
void main() {
  int ra = int(aReg.x + 0.5);
  int rb = int(aReg.y + 0.5);
  vAct = 1.0 - exp(-max(uAct[ra], uAct[rb]) * 1.3);
  if (uFocus >= 0.0) {
    int f = int(uFocus + 0.5);
    if (f != ra && f != rb) vAct *= 0.2;
  }
  vCol = mix(GREY, mix(uCol[ra], uCol[rb], aT), lit(vAct));
  vT = aT;
  vPhase = aPhase;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const linesFrag = /* glsl */ `
uniform float uTime;
varying float vT;
varying float vPhase;
varying float vAct;
varying vec3 vCol;
void main() {
  float speed = 0.35 + fract(vPhase * 7.0) * 0.6;
  float head = fract(uTime * speed + vPhase);
  float d = vT - head;
  float pulse = exp(-d * d * 150.0);                    // tight, comet-like signal
  float alpha = 0.03 + vAct * (0.05 + 0.75 * pulse);   // the web is always faintly visible; signals travel along it
  gl_FragColor = vec4(vCol * (0.75 + pulse * (0.6 + vAct)), alpha);
}`;

const shellVert = /* glsl */ `
${COMMON}
uniform float uFocus;
attribute float aReg;
varying vec3 vCol;
varying float vAct;
varying vec3 vN;
varying vec3 vV;
void main() {
  int r = int(aReg + 0.5);
  vAct = 1.0 - exp(-uAct[r] * 1.3);
  if (uFocus >= 0.0 && int(uFocus + 0.5) != r) vAct *= 0.2;
  vCol = uCol[r];
  vN = normalize(normalMatrix * normal);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;

const shellFrag = /* glsl */ `
varying vec3 vCol;
varying float vAct;
varying vec3 vN;
varying vec3 vV;
void main() {
  vec3 n = normalize(vN);
  float fres = pow(1.0 - abs(dot(n, normalize(vV))), 2.0);   // bright rim = clear silhouette
  float diff = max(dot(n, normalize(vec3(0.35, 0.55, 0.75))), 0.0); // directional shading reveals folds
  float a = 0.03 + fres * 0.26 + diff * 0.07 + vAct * (0.02 + fres * 0.12);
  vec3 col = mix(vec3(0.58, 0.63, 0.72), vCol, smoothstep(0.08, 0.55, vAct)); // neutral glass at rest, region colour only when active
  gl_FragColor = vec4(col, a);
}`;

function BrainMesh({ geo }: { geo: BrainGeometry }) {
  const group = useRef<THREE.Group>(null);
  const pointsMat = useRef<THREE.ShaderMaterial>(null);
  const linesMat = useRef<THREE.ShaderMaterial>(null);

  const pointsGeom = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(geo.positions, 3));
    g.setAttribute('aReg', new THREE.BufferAttribute(geo.regions, 1));
    g.setAttribute('aPhase', new THREE.BufferAttribute(geo.phases, 1));
    g.setAttribute('aSize', new THREE.BufferAttribute(geo.sizes, 1));
    return g;
  }, [geo]);

  const linesGeom = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(geo.lines.positions, 3));
    g.setAttribute('aT', new THREE.BufferAttribute(geo.lines.t, 1));
    g.setAttribute('aPhase', new THREE.BufferAttribute(geo.lines.phase, 1));
    g.setAttribute('aReg', new THREE.BufferAttribute(geo.lines.reg, 2));
    return g;
  }, [geo]);

  const shellGeom = useMemo(() => {
    if (!geo.shell) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(geo.shell.positions, 3));
    g.setAttribute('aReg', new THREE.BufferAttribute(geo.shell.regions, 1));
    g.setIndex(new THREE.BufferAttribute(geo.shell.indices, 1));
    g.computeVertexNormals();
    return g;
  }, [geo]);
  const shellMat = useRef<THREE.ShaderMaterial>(null);

  const shared = useMemo(() => ({ uTime: { value: 0 }, uAct: { value: act }, uCol: { value: colors }, uFocus: { value: -1 } }), []);
  const pointUniforms = useMemo(() => ({ ...shared, uMem: { value: mem }, uPx: { value: 90 } }), [shared]);

  useFrame((state, dt) => {
    decay(Math.min(dt, 0.1));
    shared.uTime.value = state.clock.elapsedTime;
    const focus = useUI.getState().focus;
    shared.uFocus.value = focus ? REGIONS.indexOf(focus) : -1;
    pointUniforms.uPx.value = state.size.height * state.gl.getPixelRatio() * 0.0085;
    if (pointsMat.current) pointsMat.current.uniformsNeedUpdate = true;
    if (linesMat.current) linesMat.current.uniformsNeedUpdate = true;
    if (shellMat.current) shellMat.current.uniformsNeedUpdate = true;
    if (group.current) group.current.position.y = Math.sin(state.clock.elapsedTime * 0.6) * 0.03; // breathing
  });

  return (
    <group ref={group} scale={1.35}>
      {shellGeom && (
        <mesh geometry={shellGeom} frustumCulled={false}>
          <shaderMaterial
            ref={shellMat}
            vertexShader={shellVert}
            fragmentShader={shellFrag}
            uniforms={shared}
            transparent
            depthWrite={false}
            blending={THREE.AdditiveBlending}
          />
        </mesh>
      )}
      <lineSegments geometry={linesGeom} frustumCulled={false}>
        <shaderMaterial
          ref={linesMat}
          vertexShader={linesVert}
          fragmentShader={linesFrag}
          uniforms={shared}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </lineSegments>
      <points geometry={pointsGeom} frustumCulled={false}>
        <shaderMaterial
          ref={pointsMat}
          vertexShader={pointsVert}
          fragmentShader={pointsFrag}
          uniforms={pointUniforms}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </points>
    </group>
  );
}

export function Brain() {
  const [geo, setGeo] = useState<BrainGeometry | null>(null);
  useEffect(() => {
    let alive = true;
    loadBrain().then((g) => alive && setGeo(g));
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    document.body.style.cursor = 'grab';
  }, []);
  return (
    <Canvas
      dpr={[1, 2]}
      camera={{ position: [0.2, 0.9, 6.2], fov: 38 }}
      gl={{ antialias: false, powerPreference: 'high-performance', alpha: true }}
      style={{ position: 'absolute', inset: 0 }}
    >
      {geo && <BrainMesh geo={geo} />}
      <OrbitControls
        enablePan={false}
        enableDamping
        dampingFactor={0.06}
        autoRotate
        autoRotateSpeed={0.45}
        minDistance={3.2}
        maxDistance={9}
      />
      <EffectComposer multisampling={0}>
        <Bloom intensity={0.18} luminanceThreshold={0.75} luminanceSmoothing={0.3} mipmapBlur radius={0.8} />
        <Vignette eskil={false} offset={0.25} darkness={0.75} />
      </EffectComposer>
    </Canvas>
  );
}
