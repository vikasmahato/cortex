"""Build the Cortex brain asset from the FreeSurfer fsaverage template.

usage: build_brain.py <nilearn_data_dir> <out_dir> [n_neurons]

Regions (index order must match packages/core REGIONS):
0 prefrontal 1 occipital 2 motor 3 parietal 4 temporal 5 hippocampus 6 cerebellum 7 amygdala
"""
import json
import sys

import numpy as np
from nilearn import datasets, surface

data_dir, out_dir = sys.argv[1], sys.argv[2]
N = int(sys.argv[3]) if len(sys.argv) > 3 else 18000
rng = np.random.default_rng(1337)

PF, OC, MO, PA, TE, HI, CB, AM = range(8)

# ---------------------------------------------------------------- landmark-based lobes
# fsaverage is in MNI-like mm space: x lateral, y anterior, z up. Boundaries are
# approximated from standard landmarks (central sulcus, Sylvian fissure, parieto-occipital).
def classify(c: np.ndarray) -> np.ndarray:
    x, y, z = np.abs(c[:, 0]), c[:, 1], c[:, 2]
    yc = -15 - 0.51 * (z - 30)          # central sulcus: runs from (y-10,z20) up/back to (y-38,z75)
    zf = 5 - 0.25 * (y - 15)            # Sylvian fissure: rises toward the back
    reg = np.full(len(c), PA, np.uint8)
    reg[(y > yc) & (y <= yc + 14)] = MO  # precentral gyrus (anterior bank of the sulcus)
    reg[(y <= yc) & (y > yc - 14) & (z > 12)] = MO  # postcentral gyrus (sensorimotor strip)
    reg[(y > yc + 14) & (z >= zf)] = PF
    reg[y > 25] = PF
    # temporal lobe: below the Sylvian line AND lateral/inferior (not the medial wall above the brainstem)
    reg[(z < zf) & (y <= 25) & (y > -62) & (reg != PF) & ((x > 28) | (z < -12))] = TE
    reg[y < -62] = OC
    return reg


fs6 = datasets.fetch_surf_fsaverage(mesh="fsaverage6", data_dir=data_dir)
meshes = {}
for side in ("left", "right"):
    pial = surface.load_surf_mesh(fs6[f"pial_{side}"])
    white = surface.load_surf_mesh(fs6[f"white_{side}"])
    meshes[side] = dict(pial=pial.coordinates.astype(np.float64), white=white.coordinates.astype(np.float64),
                        faces=np.asarray(pial.faces, dtype=np.uint32), reg=classify(pial.coordinates))

# ---------------------------------------------------------------- sample cortex neurons
def sample_surface(m, key, n):
    v, f = m[key], m["faces"]
    a, b, c = v[f[:, 0]], v[f[:, 1]], v[f[:, 2]]
    area = 0.5 * np.linalg.norm(np.cross(b - a, c - a), axis=1)
    tri = rng.choice(len(f), size=n, p=area / area.sum())
    u, w = rng.random(n), rng.random(n)
    flip = u + w > 1
    u[flip], w[flip] = 1 - u[flip], 1 - w[flip]
    bary = np.stack([1 - u - w, u, w], axis=1)
    pts = (a[tri] * bary[:, :1]) + (b[tri] * bary[:, 1:2]) + (c[tri] * bary[:, 2:3])
    pick = np.argmax(bary, axis=1)
    reg = m["reg"][f[tri, pick]]
    return pts, reg


n_pial, n_white = int(N * 0.60), int(N * 0.18)
P, R = [], []
for side in ("left", "right"):
    for key, n in (("pial", n_pial // 2), ("white", n_white // 2)):
        p, r = sample_surface(meshes[side], key, n)
        P.append(p)
        R.append(r)

# ---------------------------------------------------------------- subcortical + cerebellum (not in template)
def jitter(shape, s):
    return rng.normal(0, s, shape)

# hippocampus: curved arc from anterior head (low) to posterior tail (higher, more medial)
n_hip = int(N * 0.025)
t = rng.random(n_hip)
side = np.where(np.arange(n_hip) % 2 == 0, 1, -1)
hip = np.stack([side * (28 - 8 * t), -8 - 36 * t, -19 + 22 * t ** 1.5], axis=1) + jitter((n_hip, 3), 1.7)
P.append(hip); R.append(np.full(n_hip, HI, np.uint8))

# amygdala: small nucleus at the anterior end of the hippocampus
n_amy = int(N * 0.012)
d = rng.normal(size=(n_amy, 3)); d /= np.linalg.norm(d, axis=1, keepdims=True)
side = np.where(np.arange(n_amy) % 2 == 0, 1, -1)
amy = np.stack([side * 24, np.full(n_amy, -2.0), np.full(n_amy, -20.0)], axis=1) + d * 7 * np.cbrt(rng.random((n_amy, 1)))
P.append(amy); R.append(np.full(n_amy, AM, np.uint8))

# cerebellum + brainstem: real surface meshes (folia ridges / tapered column) so they have an outline like the cortex
def grid_mesh(fn, nu, nv):
    """Build an indexed triangle mesh from a parametric surface fn(u, v) -> (nu*nv, 3); u wraps around."""
    uu, vv = np.meshgrid(np.linspace(0, 1, nu, endpoint=False), np.linspace(0, 1, nv), indexing="ij")
    verts = fn(uu.ravel(), vv.ravel())
    idx = lambda i, j: (i % nu) * nv + j
    faces = []
    for i in range(nu):
        for j in range(nv - 1):
            a, b, c, d = idx(i, j), idx(i + 1, j), idx(i + 1, j + 1), idx(i, j + 1)
            faces.append((a, b, c)); faces.append((a, c, d))
    return verts.astype(np.float64), np.array(faces, dtype=np.uint32)


def cerebellum_surface(u, v):
    th, ph = v * np.pi, u * 2 * np.pi
    d = np.stack([np.sin(th) * np.cos(ph), np.sin(th) * np.sin(ph), np.cos(th)], axis=1)  # x lateral, y AP, z up
    folia = 1 + 0.045 * np.sin(d[:, 2] * 38 + d[:, 1] * 2.0)           # horizontal ridges (folia)
    vermis = 1 - 0.05 * np.exp(-(d[:, 0] * 5) ** 2)                      # shallow midline groove
    p = np.array([0, -68, -42]) + d * np.array([44, 28, 17]) * (folia * vermis)[:, None]
    top = p[:, 2] > -27
    p[top, 2] = -27 + (p[top, 2] + 27) * 0.35                             # flatten the roof under the occipital lobe
    return p


def brainstem_surface(u, v):
    t, ph = v, u * 2 * np.pi
    r = 9 - 3 * t + 3 * np.exp(-(((t - 0.25) / 0.12) ** 2))             # pons bulge
    c = np.stack([np.zeros_like(t), -20 - 18 * t, -22 - 56 * t], axis=1)
    return c + np.stack([np.cos(ph) * r, np.sin(ph) * r * 0.85, np.zeros_like(t)], axis=1)


cb_v, cb_f = grid_mesh(cerebellum_surface, 150, 80)
st_v, st_f = grid_mesh(brainstem_surface, 40, 40)
cb_m = dict(s=cb_v, faces=cb_f, reg=np.full(len(cb_v), CB, np.uint8))
st_m = dict(s=st_v, faces=st_f, reg=np.full(len(st_v), CB, np.uint8))

for m, n, center in ((cb_m, int(N * 0.11), np.array([0, -68, -42.0])), (st_m, int(N * 0.03), np.array([0, -30, -50.0]))):
    p, r = sample_surface(m, "s", n)
    inner = rng.random(n) < 0.18                                          # a few deeper neurons for volume
    p[inner] = center + (p[inner] - center) * rng.uniform(0.6, 0.92, (inner.sum(), 1))
    P.append(p); R.append(r)

pts = np.concatenate(P).astype(np.float64)
reg = np.concatenate(R).astype(np.uint8)

# ---------------------------------------------------------------- shell mesh (cortex pial + cerebellum + brainstem)
nl = len(meshes["left"]["pial"])
nr = len(meshes["right"]["pial"])
sv = np.concatenate([meshes["left"]["pial"], meshes["right"]["pial"], cb_v, st_v])
sr = np.concatenate([meshes["left"]["reg"], meshes["right"]["reg"], cb_m["reg"], st_m["reg"]])
sf = np.concatenate([
    meshes["left"]["faces"],
    meshes["right"]["faces"] + nl,
    cb_f + nl + nr,
    st_f + nl + nr + len(cb_v),
]).astype(np.uint32)

# ---------------------------------------------------------------- to app space
# mm RAS (x lateral, y anterior, z up) -> app (x anterior, y up, z lateral), unit scale ~ procedural brain
SCALE = 3.1 / 174.0
Y0, Z0 = -18.0, 5.0
def to_app(a):
    return np.stack([(a[:, 1] - Y0) * SCALE, (a[:, 2] - Z0) * SCALE, a[:, 0] * SCALE], axis=1).astype(np.float32)

pts_app, sv_app = to_app(pts), to_app(sv)

# ---------------------------------------------------------------- pack
def pad4(b: bytes) -> bytes:
    return b + b"\0" * (-len(b) % 4)

chunks, meta = [], {"scale": SCALE, "regions": ["prefrontal", "occipital", "motor", "parietal", "temporal", "hippocampus", "cerebellum", "amygdala"]}
offset = 0
for key, arr in (("neuronPos", pts_app), ("neuronReg", reg), ("shellPos", sv_app), ("shellReg", sr), ("shellIdx", sf.reshape(-1))):
    raw = pad4(np.ascontiguousarray(arr).tobytes())
    meta[key] = {"offset": offset, "count": int(arr.shape[0]), "bytes": len(raw)}
    chunks.append(raw)
    offset += len(raw)

import os
os.makedirs(out_dir, exist_ok=True)
with open(os.path.join(out_dir, "brain.bin"), "wb") as fh:
    for c in chunks:
        fh.write(c)
with open(os.path.join(out_dir, "brain.json"), "w") as fh:
    json.dump(meta, fh, indent=1)

print(f"neurons {len(pts_app)}  shell verts {len(sv_app)} tris {len(sf)}  bin {offset/1e6:.2f} MB")
print("neurons per region:", dict(zip(meta["regions"], np.bincount(reg, minlength=8).tolist())))
print("app-space bounds min", pts_app.min(0).round(2), "max", pts_app.max(0).round(2))
