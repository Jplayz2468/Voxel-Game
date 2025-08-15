#!/usr/bin/env python3
# pip install numpy noise trimesh
import numpy as np
from noise import snoise2
import trimesh
from math import pow

# ===== Terrain settings (same baseline) =====
WORLD_M      = 512
GRID         = 512
MAX_H        = 50.0
SEA_LEVEL    = 5.0
SCALE        = 85.0
OCTAVES      = 6
LACUNARITY   = 2.0
GAIN         = 0.5
POWER        = 1.3
FLATTER      = 0.9
DETAIL_SCALE = 1.2
SEED         = 42

# ===== Tree placement (water + niceness) =====
MOISTURE_MU     = 0.55
MOISTURE_SIGMA  = 0.18
SLOPE_MAX_DEG   = 26.0
EDGE_BUFFER_M   = 4.0
BANK_CLEAR_M    = 2.0

BASE_USAGE      = 0.015
BIG_USAGE       = BASE_USAGE * 10.0
INFLUENCE_R_M   = 12.0        # water depletion radius
SPACING_M       = 3.0         # hard min spacing
BIG_SPACING_M   = 6.0         # a bit larger for mega
MAX_TREES       = 1800

# Soft density shaping so it spreads nicely in wet areas
DENSITY_RADIUS_M   = 6.0      # where neighbors reduce score
DENSITY_WEIGHT     = 0.35     # how strong the penalty is (0..1)

# ===== Spheres (touching surface) =====
DOT_R        = 0.24                          # normal tree radius (2× previous)
DOT_R_BIG    = DOT_R * pow(10.0, 1.0/3.0)    # 10× volume → cbrt(10) radius ≈ 2.154×
SPHERE_SUBDIV = 1

# ===============================================================

def generate_heightmap():
    xs = np.linspace(0, 1, GRID)
    zs = np.linspace(0, 1, GRID)
    H = np.zeros((GRID, GRID), dtype=np.float32)
    for z in range(GRID):
        for x in range(GRID):
            f = (1.0 / SCALE) * DETAIL_SCALE
            amp = 1.0; n = 0.0; norm = 0.0
            for o in range(OCTAVES):
                nx = xs[x] * SCALE * f
                nz = zs[z] * SCALE * f
                n += amp * snoise2(nx, nz, base=SEED + o)
                norm += amp
                amp *= GAIN
                f *= LACUNARITY
            H[z, x] = (n / norm + 1.0) * 0.5
    H = np.power(H, POWER) * MAX_H * FLATTER
    # Gentle shore smoothing
    band = 2.0
    mask = H < SEA_LEVEL + band
    t = np.clip((H - SEA_LEVEL) / band, 0.0, 1.0)
    H[mask] = SEA_LEVEL + (H[mask] - SEA_LEVEL) * (t[mask]**2 * (3 - 2*t[mask]))
    return H

def slope_and_normals(H, world_m):
    n = H.shape[0]
    step = world_m / (n - 1)
    dHz, dHx = np.gradient(H, step, step)
    slope = np.degrees(np.arctan(np.hypot(dHx, dHz)))
    nx = -dHx; ny = np.ones_like(H, dtype=np.float32); nz = -dHz
    inv = 1.0 / np.clip(np.sqrt(nx*nx + ny*ny + nz*nz), 1e-9, None)
    return slope, np.stack((nx*inv, ny*inv, nz*inv), axis=-1)

def laplacian(h):
    p = np.pad(h, 1, mode='edge')
    return (p[:-2,1:-1] + p[2:,1:-1] + p[1:-1,:-2] + p[1:-1,2:] - 4.0*h)

def flow_accum(h, iters=1):
    n, m = h.shape
    acc = np.ones_like(h, dtype=np.float32)
    for _ in range(iters):
        nxt = np.zeros_like(h, dtype=np.float32)
        for z in range(1, n-1):
            hz = h[z]
            for x in range(1, m-1):
                c = hz[x]
                best_dh = 0.0; bz = 0; bx = 0
                for dz,dx in ((-1,-1),(-1,0),(-1,1),(0,-1),(0,1),(1,-1),(1,0),(1,1)):
                    dh = c - h[z+dz, x+dx]
                    if dh > best_dh:
                        best_dh = dh; bz = dz; bx = dx
                nxt[z+bz, x+bx] += acc[z, x]
        acc = np.clip(nxt, 1.0, None)
    acc /= (acc.max() if acc.max() > 0 else 1.0)
    return acc

def normalize01(a):
    a_min, a_max = float(a.min()), float(a.max())
    if a_max - a_min < 1e-9: return np.zeros_like(a, dtype=np.float32)
    return ((a - a_min) / (a_max - a_min)).astype(np.float32)

def moisture_potential(H):
    flow = flow_accum(H, iters=1)
    conc = np.clip(-laplacian(H), 0.0, None); conc = normalize01(conc)
    low  = 1.0 - normalize01(H)
    W = 0.55*flow + 0.30*conc + 0.15*low
    return normalize01(W)

def gaussian_pref(x, mu, sigma):
    return np.exp(-0.5 * ((x - mu) / max(sigma,1e-6))**2)

def build_kernel(radius_cells, sigma_cells):
    r = int(np.ceil(radius_cells))
    y, x = np.mgrid[-r:r+1, -r:r+1]
    d2 = x*x + y*y
    k = np.exp(-0.5 * d2 / (sigma_cells**2))
    k[d2 > radius_cells*radius_cells] = 0.0
    s = k.sum()
    return k / s if s > 0 else k

def place_trees(H, normals, W):
    n = H.shape[0]
    cell_m = WORLD_M / (n - 1)

    edge_buf = int(np.ceil(EDGE_BUFFER_M / cell_m))
    slope_deg, _ = slope_and_normals(H, WORLD_M)
    eligible = (slope_deg <= SLOPE_MAX_DEG) & (H >= SEA_LEVEL + BANK_CLEAR_M)
    eligible[:edge_buf,:] = False; eligible[-edge_buf:,:] = False
    eligible[:,:edge_buf] = False; eligible[:,-edge_buf:] = False

    water_left = W.copy()
    pref = gaussian_pref(W, MOISTURE_MU, MOISTURE_SIGMA)

    spacing_cells      = max(1.0, SPACING_M / cell_m)
    big_spacing_cells  = max(1.0, BIG_SPACING_M / cell_m)
    infl_cells         = max(1.0, INFLUENCE_R_M / cell_m)
    kernel = build_kernel(infl_cells, infl_cells*0.5)

    # Soft density map and kernel
    dens_cells = max(1.0, DENSITY_RADIUS_M / cell_m)
    dens_kernel = build_kernel(dens_cells, dens_cells*0.6)
    density = np.zeros_like(H, dtype=np.float32)

    blocked = np.zeros_like(H, dtype=bool)
    placed  = []
    first_big = True
    trees = 0

    def block_disk(cx, cz, rad_cells):
        r = int(np.ceil(rad_cells))
        y, x = np.ogrid[-r:r+1, -r:r+1]
        mask = (x*x + y*y) <= rad_cells*rad_cells
        z0 = max(0, cz - r); z1 = min(n, cz + r + 1)
        x0 = max(0, cx - r); x1 = min(n, cx + r + 1)
        bz0, bz1 = r - (cz - z0), r + (z1 - cz) - 1
        bx0, bx1 = r - (cx - x0), r + (x1 - cx) - 1
        blocked[z0:z1, x0:x1][mask[bz0:bz1+1, bx0:bx1+1]] = True

    def apply_depletion(cx, cz, usage, kern):
        r = (kern.shape[0] - 1) // 2
        z0 = max(0, cz - r); z1 = min(n, cz + r + 1)
        x0 = max(0, cx - r); x1 = min(n, cx + r + 1)
        kz0, kz1 = r - (cz - z0), r + (z1 - cz) - 1
        kx0, kx1 = r - (cx - x0), r + (x1 - cx) - 1
        water_left[z0:z1, x0:x1] = np.clip(
            water_left[z0:z1, x0:x1] - usage * kern[kz0:kz1+1, kx0:kx1+1], 0.0, None
        )
        # update local density (soft penalty for nearby future picks)
        density[z0:z1, x0:x1] += kern[kz0:kz1+1, kx0:kx1+1]

    while trees < MAX_TREES:
        # Score: prefer good moisture and low local density
        score = pref * water_left * (1.0 - DENSITY_WEIGHT * np.clip(density, 0, 1))
        score[~eligible] = 0.0
        score[blocked]   = 0.0
        if score.max() < 1e-4: break
        iz, ix = np.unravel_index(np.argmax(score), score.shape)
        if H[iz, ix] <= SEA_LEVEL + 0.5:
            eligible[iz, ix] = False
            continue

        if first_big:
            usage = BIG_USAGE; rad_cells = big_spacing_cells; r = DOT_R_BIG
            first_big = False
        else:
            usage = BASE_USAGE; rad_cells = spacing_cells; r = DOT_R

        x_m = ix * cell_m; z_m = iz * cell_m; y_m = float(H[iz, ix])
        nvec = normals[iz, ix]
        center = np.array([x_m, y_m, z_m], dtype=np.float32) + nvec * r
        placed.append((center, r))

        apply_depletion(ix, iz, usage, kernel)
        block_disk(ix, iz, rad_cells)
        trees += 1

    return placed

def mesh_from_height(H, size_m):
    n = H.shape[0]
    xs = np.linspace(0, size_m, n, dtype=np.float32)
    zs = np.linspace(0, size_m, n, dtype=np.float32)
    X, Z = np.meshgrid(xs, zs)
    V = np.stack([X.ravel(), H.ravel(), Z.ravel()], axis=1)
    idx = np.arange(n*n, dtype=np.int64).reshape(n, n)
    f1 = np.stack([idx[:-1,:-1].ravel(), idx[:-1,1:].ravel(), idx[1:,1:].ravel()], axis=1)
    f2 = np.stack([idx[:-1,:-1].ravel(), idx[1:,1:].ravel(), idx[1:,:-1].ravel()], axis=1)
    F = np.vstack([f1, f2])
    return trimesh.Trimesh(vertices=V, faces=F, process=False)

def main():
    print("Generating heightmap…")
    H = generate_heightmap()
    print("Normals & moisture…")
    slope_deg, normals = slope_and_normals(H, WORLD_M)
    W = moisture_potential(H)
    print("Placing trees…")
    placements = place_trees(H, normals, W)
    print(f"Placed {len(placements)} spheres")

    print("Meshing terrain…")
    terrain = mesh_from_height(H, WORLD_M)
    water = trimesh.creation.box(extents=[WORLD_M, 0.1, WORLD_M])
    water.apply_translation([WORLD_M/2, SEA_LEVEL-0.05, WORLD_M/2])

    meshes = [terrain, water]
    for center, r in placements:
        sph = trimesh.creation.icosphere(subdivisions=SPHERE_SUBDIV, radius=r)
        sph.apply_translation(center)
        meshes.append(sph)

    scene = trimesh.util.concatenate(meshes)
    scene.export("terrain_trees_spheres.obj")
    print("Done: terrain_trees_spheres.obj")

if __name__ == "__main__":
    main()
