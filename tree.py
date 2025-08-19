# tree_wireframe.py
# Branch-only procedural tree (wireframe), inspired by EZ-Tree (MIT-licensed).
# Run: python tree_wireframe.py

import math
import random
from dataclasses import dataclass
from typing import List, Tuple
import numpy as np
from matplotlib import pyplot as plt
from mpl_toolkits.mplot3d import Axes3D  # noqa: F401  # needed for 3D

# ---------- Basic math helpers ----------
@dataclass
class Vec3:
    x: float; y: float; z: float
    def as_np(self): return np.array([self.x, self.y, self.z], dtype=float)
    @staticmethod
    def from_np(a): return Vec3(float(a[0]), float(a[1]), float(a[2]))

def rot_x(v: np.ndarray, angle: float) -> np.ndarray:
    c, s = math.cos(angle), math.sin(angle)
    R = np.array([[1,0,0],[0,c,-s],[0,s,c]], dtype=float)
    return R @ v

def rot_y(v: np.ndarray, angle: float) -> np.ndarray:
    c, s = math.cos(angle), math.sin(angle)
    R = np.array([[c,0,s],[0,1,0],[-s,0,c]], dtype=float)
    return R @ v

def rot_z(v: np.ndarray, angle: float) -> np.ndarray:
    c, s = math.cos(angle), math.sin(angle)
    R = np.array([[c,-s,0],[s,c,0],[0,0,1]], dtype=float)
    return R @ v

def apply_euler(up_vec: np.ndarray, ex: float, ey: float, ez: float) -> np.ndarray:
    # order XYZ to loosely match Three.js default Euler order
    v = rot_x(up_vec, ex)
    v = rot_y(v, ey)
    v = rot_z(v, ez)
    return v

def lerp(a: np.ndarray, b: np.ndarray, t: float) -> np.ndarray:
    return a*(1-t) + b*t

# ---------- Options mirroring EZ-Tree concepts ----------
@dataclass
class BranchSpec:
    levels: int
    length: List[float]      # per level
    radius: List[float]      # per level
    sections: List[int]      # per level
    angle: List[float]       # degrees, per level (child tilt from parent)
    children: List[int]      # per level
    start: List[float]       # per level, [0..1], earliest child start
    taper: List[float]       # per level, [0..1]
    gnarliness: List[float]  # per level
    twist: List[float]       # per level, radians per section
    force_dir: Vec3          # global growth direction (unit-ish)
    force_strength: float    # amount of tilt per section (scaled by 1/r)

@dataclass
class Options:
    seed: int
    type: str  # "Deciduous" or "Evergreen"
    branch: BranchSpec

@dataclass
class BranchState:
    origin: np.ndarray       # current section origin
    ex: float; ey: float; ez: float   # Euler orientation (radians)
    length: float
    radius: float
    level: int
    section_count: int

class TreeWireframe:
    def __init__(self, opt: Options):
        self.opt = opt
        self.rng = random.Random(opt.seed)
        self.lines: List[Tuple[np.ndarray, np.ndarray, float, int]] = []  # (p0, p1, radius, level)
        # 3D mesh data
        self.vertices: List[np.ndarray] = []
        self.faces: List[Tuple[int, int, int]] = []
        self.radii: List[float] = []
        self.segments = 8  # number of segments around each cylinder
        self.skipped_count = 0  # debug counter
        
        # Leaf data
        self.leaf_vertices: List[np.ndarray] = []
        self.leaf_faces: List[Tuple[int, int, int]] = []

    def _is_decid(self) -> bool:
        return self.opt.type.lower().startswith("decid")

    def generate(self):
        # BFS queue over branches
        q: List[BranchState] = [BranchState(
            origin=np.array([0.0, 0.0, 0.0], dtype=float),
            ex=0.0, ey=0.0, ez=0.0,
            length=self.opt.branch.length[0],
            radius=self.opt.branch.radius[0],
            level=0,
            section_count=self.opt.branch.sections[0],
        )]
        radial_seed = self.rng.random()  # used to distribute child azimuths more evenly

        while q:
            b = q.pop(0)
            sections = self._grow_branch_sections(b)  # returns list of (origin, ex, ey, ez, radius)

            # Spawn children or stop
            if b.level < self.opt.branch.levels:
                child_count = self.opt.branch.children[b.level]
                if child_count > 0 and len(sections) > 1:
                    for i in range(child_count):
                        # pick start along parent
                        t0 = self.opt.branch.start[b.level]
                        t = self.rng.uniform(t0, 1.0)
                        idxf = t * (len(sections)-1)
                        i0 = min(len(sections)-2, max(0, int(math.floor(idxf))))
                        i1 = i0 + 1
                        alpha = idxf - i0

                        o0, ex0, ey0, ez0, r0 = sections[i0]
                        o1, ex1, ey1, ez1, r1 = sections[i1]

                        origin = lerp(o0, o1, alpha)
                        # slerp-euler (cheap linear blend; good enough for wireframe)
                        ex = (1-alpha)*ex1 + alpha*ex0
                        ey = (1-alpha)*ey1 + alpha*ey0
                        ez = (1-alpha)*ez1 + alpha*ez0

                        # child orientation: tilt by angle around X, then rotate around Y by radial
                        angle_rad = math.radians(self.opt.branch.angle[b.level])
                        radial = 2.0*math.pi*(radial_seed + i/child_count)
                        ex_child = ex + angle_rad
                        ey_child = ey + radial

                        # child radius scales by parent radius at that point
                        r_child = self.opt.branch.radius[b.level+1] * ((1-alpha)*r0 + alpha*r1)
                        # child length
                        if self._is_decid():
                            length = self.opt.branch.length[b.level+1]
                        else:
                            length = self.opt.branch.length[b.level+1] * (1.0 - t)  # evergreen taper rule

                        q.append(BranchState(
                            origin=origin,
                            ex=ex_child, ey=ey_child, ez=ez,  # keep ez
                            length=length,
                            radius=r_child,
                            level=b.level+1,
                            section_count=self.opt.branch.sections[b.level+1],
                        ))
            # Generate leaves at terminal branches (last level)
            if b.level == self.opt.branch.levels:
                # Add leaves along the terminal branch
                self._generate_leaves_on_branch(sections)
            
            # Add sparse leaves to any branch that has thin sections (spread throughout tree)
            elif b.level >= 1:  # not the trunk, but non-terminal branches
                self._generate_scattered_leaves_on_branch(sections)

        return self.lines

    def _grow_branch_sections(self, b: BranchState):
        # Deciduous: special per-level section scaling like EZ-Tree
        denom = (self.opt.branch.levels - 1) if (self._is_decid() and self.opt.branch.levels > 1) else 1
        sec_len = b.length / b.section_count / max(1, denom)

        origin = b.origin.copy()
        ex, ey, ez = b.ex, b.ey, b.ez
        sections = []

        for i in range(b.section_count):
            # current radius with taper
            if self._is_decid():
                r = b.radius * (1.0 - self.opt.branch.taper[b.level] * (i / b.section_count))
            else:
                r = b.radius * (1.0 - i / b.section_count)

            # next point along local up (0, sec_len, 0) rotated by current Euler
            up = np.array([0.0, sec_len, 0.0], dtype=float)
            dir_world = apply_euler(up, ex, ey, ez)
            nxt = origin + dir_world

            # record line segment (wire)
            self.lines.append((origin.copy(), nxt.copy(), r, b.level))
            
            # create cylindrical geometry for this section
            self._create_cylinder_section(origin, nxt, r, i == 0)

            # store section (used for child interpolation)
            sections.append((origin.copy(), ex, ey, ez, r))

            # advance
            origin = nxt

            # orientation perturb: gnarliness grows when radius thins (1/sqrt(r))
            gn = max(1.0, 1.0 / max(1e-6, math.sqrt(r))) * self.opt.branch.gnarliness[b.level]
            ex += self.rng.uniform(-gn, gn)
            ez += self.rng.uniform(-gn, gn)

            # apply twist (around Y)
            ey += self.opt.branch.twist[b.level]

            # apply growth force: tilt a bit toward force_dir; scale by strength/r
            # Simple heuristic: project force into pitch/roll deltas
            f = self.opt.branch.force_dir.as_np()
            f = f / (np.linalg.norm(f) + 1e-9)
            tilt = self.opt.branch.force_strength / max(1e-4, r)
            ex += tilt * f[0]
            ez += tilt * f[2]

        # push final cap section (radius ~0 at very tip if terminal level)
        if b.level == self.opt.branch.levels:
            r_tip = 0.001
        else:
            r_tip = (self._is_decid()
                     and b.radius * (1.0 - self.opt.branch.taper[b.level])
                     or b.radius * (1.0 - 1.0))
        sections.append((origin.copy(), ex, ey, ez, r_tip))
        return sections
    
    def _create_cylinder_section(self, start: np.ndarray, end: np.ndarray, radius: float, is_first: bool):
        """Create cylindrical geometry for a branch section"""
        # Make very thin branches at least minimally visible  
        min_radius = 0.002  # minimum visible radius (more visible)
        display_radius = max(radius, min_radius)
        
        # direction vector from start to end
        direction = end - start
        length = np.linalg.norm(direction)
        if length < 1e-6:
            self.skipped_count += 1
            return
            
        direction = direction / length
        
        # create orthogonal vectors for the cylinder cross-section
        # find a vector not parallel to direction
        if abs(direction[1]) < 0.9:
            up = np.array([0, 1, 0])
        else:
            up = np.array([1, 0, 0])
            
        # create two orthogonal vectors perpendicular to direction
        right = np.cross(direction, up)
        right = right / np.linalg.norm(right)
        forward = np.cross(right, direction)
        forward = forward / np.linalg.norm(forward)
        
        # determine start vertex indices
        if is_first:
            # create vertices around the start circle for the first section
            start_idx = len(self.vertices)
            for i in range(self.segments):
                angle = 2.0 * math.pi * i / self.segments
                offset = display_radius * (math.cos(angle) * right + math.sin(angle) * forward)
                vertex = start + offset
                self.vertices.append(vertex)
                self.radii.append(display_radius)
        else:
            # reuse the end vertices from the previous section as start vertices
            start_idx = len(self.vertices) - self.segments
        
        # create vertices around the end circle
        end_idx = len(self.vertices)
        for i in range(self.segments):
            angle = 2.0 * math.pi * i / self.segments
            offset = display_radius * (math.cos(angle) * right + math.sin(angle) * forward)
            vertex = end + offset
            self.vertices.append(vertex)
            self.radii.append(display_radius)
        
        # create faces connecting the two circles (cylinder sides)
        for i in range(self.segments):
            # get vertex indices for the quad
            i1 = start_idx + i
            i2 = start_idx + (i + 1) % self.segments
            i3 = end_idx + i
            i4 = end_idx + (i + 1) % self.segments
            
            # create two triangles for each quad face
            self.faces.append((i1, i3, i2))
            self.faces.append((i2, i3, i4))
    
    def _generate_leaves_on_branch(self, sections):
        """Generate leaves along a terminal branch, concentrated at the very tips"""
        # Generate more leaves per terminal branch, heavily biased toward tips
        num_leaves = self.rng.randint(8, 15)
        
        for i in range(num_leaves):
            # Heavily bias toward the very end of the branch (quadratic bias)
            random_val = self.rng.random()
            t = 0.7 + 0.3 * (random_val ** 0.3)  # Strong bias toward tip (0.7-1.0 range)
            
            section_idx = min(len(sections) - 2, int(t * (len(sections) - 1)))
            alpha = (t * (len(sections) - 1)) - section_idx
            
            # Interpolate position and orientation
            s1 = sections[section_idx]
            s2 = sections[section_idx + 1]
            
            leaf_pos = lerp(s1[0], s2[0], alpha)  # origin
            
            # Interpolate branch orientation
            ex = (1-alpha) * s1[1] + alpha * s2[1]  # ex euler angle
            ey = (1-alpha) * s1[2] + alpha * s2[2]  # ey euler angle
            ez = (1-alpha) * s1[3] + alpha * s2[3]  # ez euler angle
            
            # Add some random offset from the branch (smaller offset for tip leaves)
            radial_angle = self.rng.uniform(0, 2 * math.pi)
            offset_dist = self.rng.uniform(0.05, 0.2)
            offset = np.array([
                math.cos(radial_angle) * offset_dist,
                self.rng.uniform(-0.05, 0.15),  # slight upward bias
                math.sin(radial_angle) * offset_dist
            ])
            leaf_pos += offset
            
            # Random leaf size (10% bigger)
            leaf_size = self.rng.uniform(0.56, 1.12)
            
            # Create the billboard leaf with branch orientation
            self._create_billboard_leaf(leaf_pos, leaf_size, ex, ey, ez)
    
    def _generate_scattered_leaves_on_branch(self, sections):
        """Generate scattered leaves on non-terminal branches based on section thinness"""
        for i, section in enumerate(sections[:-1]):  # skip last section
            section_radius = section[4]  # radius is 5th element
            
            # Only add leaves to thin sections, with probability based on thinness
            if section_radius < 0.15:  # much thicker threshold
                # Probability decreases with thickness
                leaf_probability = max(0.2, min(0.9, (0.15 - section_radius) / 0.1))
                
                if self.rng.random() < leaf_probability:
                    # Position at this section
                    leaf_pos = section[0].copy()  # section origin
                    
                    # Get section orientation
                    ex, ey, ez = section[1], section[2], section[3]
                    
                    # Add random offset from the branch
                    radial_angle = self.rng.uniform(0, 2 * math.pi)
                    offset_dist = self.rng.uniform(0.1, 0.3)
                    offset = np.array([
                        math.cos(radial_angle) * offset_dist,
                        self.rng.uniform(-0.05, 0.2),
                        math.sin(radial_angle) * offset_dist
                    ])
                    leaf_pos += offset
                    
                    # Leaf size based on section thickness
                    leaf_size = self.rng.uniform(0.2, 0.5)
                    
                    # Create the billboard leaf
                    self._create_billboard_leaf(leaf_pos, leaf_size, ex, ey, ez)
    
    def voxelize(self, target_height_meters=10.0, voxels_per_meter=16):
        """Convert the tree mesh to voxels"""
        # Combine all vertices and faces
        all_vertices = self.vertices + self.leaf_vertices
        branch_face_count = len(self.faces)
        
        # Adjust leaf face indices
        adjusted_leaf_faces = []
        for face in self.leaf_faces:
            adjusted_face = tuple(idx + len(self.vertices) for idx in face)
            adjusted_leaf_faces.append(adjusted_face)
        
        all_faces = self.faces + adjusted_leaf_faces
        
        if not all_vertices:
            return None, None
            
        # Convert to numpy arrays
        vertices = np.array([v for v in all_vertices])
        
        # Calculate current tree bounds
        min_bounds = np.min(vertices, axis=0)
        max_bounds = np.max(vertices, axis=0)
        current_height = max_bounds[1] - min_bounds[1]
        
        # Scale factor to make tree 10 meters tall
        scale_factor = target_height_meters / current_height
        
        # Scale vertices
        scaled_vertices = vertices * scale_factor
        
        # Recalculate bounds after scaling
        min_bounds = np.min(scaled_vertices, axis=0)
        max_bounds = np.max(scaled_vertices, axis=0)
        
        # Add padding around the tree
        padding = 1.0  # 1 meter padding
        min_bounds -= padding
        max_bounds += padding
        
        # Calculate voxel grid dimensions
        grid_size = (max_bounds - min_bounds) * voxels_per_meter
        grid_dims = np.ceil(grid_size).astype(int)
        
        print(f"Tree scaled to {target_height_meters}m height (scale factor: {scale_factor:.3f})")
        print(f"Voxel grid dimensions: {grid_dims} ({np.prod(grid_dims):,} total voxels)")
        
        # Create voxel grids (0=empty, 1=branch, 2=leaf)
        voxel_grid = np.zeros(grid_dims, dtype=np.uint8)
        
        # Voxelize each triangle
        self._voxelize_triangles(scaled_vertices, all_faces, branch_face_count, 
                               voxel_grid, min_bounds, voxels_per_meter)
        
        return voxel_grid, min_bounds
    
    def _voxelize_triangles(self, vertices, faces, branch_face_count, voxel_grid, min_bounds, voxels_per_meter):
        """Voxelize all triangular faces using vertex-based approach"""
        print(f"Voxelizing {len(faces)} triangles...")
        
        # Simple approach: for each vertex, mark nearby voxels
        for i, vertex in enumerate(vertices):
            if i % 1000 == 0:
                print(f"  Processing vertex {i}/{len(vertices)}")
                
            # Determine vertex type
            voxel_type = 1 if i < len(self.vertices) else 2  # 1=branch, 2=leaf
            
            # Convert vertex to voxel coordinates
            voxel_pos = ((vertex - min_bounds) * voxels_per_meter).astype(int)
            
            # Clamp to grid bounds
            voxel_pos = np.maximum(voxel_pos, 0)
            voxel_pos = np.minimum(voxel_pos, np.array(voxel_grid.shape) - 1)
            
            # Mark this voxel only (skip neighbors for speed)
            x, y, z = voxel_pos
            if voxel_grid[x, y, z] == 0:
                voxel_grid[x, y, z] = voxel_type
                                
        print("Voxelization complete!")
    
    def _voxelize_triangle(self, v0, v1, v2, voxel_grid, min_bounds, voxels_per_meter, voxel_type):
        """Voxelize a single triangle using simplified approach"""
        # Calculate triangle bounding box in world coordinates
        tri_min = np.minimum(np.minimum(v0, v1), v2)
        tri_max = np.maximum(np.maximum(v0, v1), v2)
        
        # Convert to voxel coordinates
        voxel_min = np.floor((tri_min - min_bounds) * voxels_per_meter).astype(int)
        voxel_max = np.ceil((tri_max - min_bounds) * voxels_per_meter).astype(int)
        
        # Clamp to grid bounds
        voxel_min = np.maximum(voxel_min, 0)
        voxel_max = np.minimum(voxel_max, np.array(voxel_grid.shape) - 1)
        
        # Simplified: just fill the bounding box (faster for dense meshes)
        voxel_grid[voxel_min[0]:voxel_max[0]+1, 
                   voxel_min[1]:voxel_max[1]+1, 
                   voxel_min[2]:voxel_max[2]+1] = np.where(
                       voxel_grid[voxel_min[0]:voxel_max[0]+1, 
                                  voxel_min[1]:voxel_max[1]+1, 
                                  voxel_min[2]:voxel_max[2]+1] == 0,
                       voxel_type,
                       voxel_grid[voxel_min[0]:voxel_max[0]+1, 
                                  voxel_min[1]:voxel_max[1]+1, 
                                  voxel_min[2]:voxel_max[2]+1]
                   )
    
    def _voxel_intersects_triangle(self, voxel_center, v0, v1, v2, voxel_size):
        """Check if a voxel intersects with a triangle"""
        # Simple approach: check if voxel center is close to triangle
        # or if triangle intersects voxel bounds
        
        # Calculate triangle normal and plane equation
        edge1 = v1 - v0
        edge2 = v2 - v0
        normal = np.cross(edge1, edge2)
        normal_len = np.linalg.norm(normal)
        
        if normal_len < 1e-10:  # degenerate triangle
            return False
            
        normal = normal / normal_len
        
        # Distance from voxel center to triangle plane
        plane_dist = abs(np.dot(normal, voxel_center - v0))
        
        # If voxel is too far from plane, no intersection
        half_voxel = voxel_size * 0.5
        if plane_dist > half_voxel * 1.732:  # sqrt(3) for diagonal
            return False
        
        # Project voxel center onto triangle plane
        projected = voxel_center - normal * np.dot(normal, voxel_center - v0)
        
        # Check if projected point is inside triangle using barycentric coordinates
        v0v1 = v1 - v0
        v0v2 = v2 - v0
        v0p = projected - v0
        
        dot00 = np.dot(v0v2, v0v2)
        dot01 = np.dot(v0v2, v0v1)
        dot02 = np.dot(v0v2, v0p)
        dot11 = np.dot(v0v1, v0v1)
        dot12 = np.dot(v0v1, v0p)
        
        inv_denom = 1 / (dot00 * dot11 - dot01 * dot01)
        u = (dot11 * dot02 - dot01 * dot12) * inv_denom
        v = (dot00 * dot12 - dot01 * dot02) * inv_denom
        
        # Check if point is in triangle
        in_triangle = (u >= -0.1) and (v >= -0.1) and (u + v <= 1.1)  # small tolerance
        
        # If close to triangle, consider it intersecting
        return in_triangle or plane_dist < half_voxel
    
    def _create_billboard_leaf(self, position: np.ndarray, size: float, ex: float, ey: float, ez: float):
        """Create a billboard leaf with two perpendicular squares, oriented to branch slope"""
        half_size = size * 0.5
        
        # Add random rotation around Y axis for natural variation
        random_rotation_y = self.rng.uniform(-0.5, 0.5)  # smaller random variation
        
        start_vertex_idx = len(self.leaf_vertices)
        
        # Create first square (in XY plane)
        square1_verts = [
            np.array([-half_size, -half_size, 0]),  # bottom left
            np.array([half_size, -half_size, 0]),   # bottom right
            np.array([half_size, half_size, 0]),    # top right
            np.array([-half_size, half_size, 0])    # top left
        ]
        
        # Create second square with random angle (not always 90 degrees)
        random_angle = self.rng.uniform(math.pi/3, 2*math.pi/3)  # 60-120 degrees
        cos_a, sin_a = math.cos(random_angle), math.sin(random_angle)
        
        square2_verts = [
            np.array([cos_a * (-half_size), -half_size, sin_a * (-half_size)]),  # bottom left
            np.array([cos_a * half_size, -half_size, sin_a * half_size]),        # bottom right
            np.array([cos_a * half_size, half_size, sin_a * half_size]),         # top right
            np.array([cos_a * (-half_size), half_size, sin_a * (-half_size)])    # top left
        ]
        
        # Apply branch orientation and random rotation to all vertices
        all_verts = square1_verts + square2_verts
        for vert in all_verts:
            # Apply branch orientation (same as branch sections)
            rotated = apply_euler(vert, ex, ey + random_rotation_y, ez)
            final_pos = position + rotated
            self.leaf_vertices.append(final_pos)
        
        # Create faces for both squares (2 triangles per square = 4 triangles total)
        base_idx = start_vertex_idx
        
        # First square faces
        self.leaf_faces.append((base_idx, base_idx + 1, base_idx + 2))      # triangle 1
        self.leaf_faces.append((base_idx, base_idx + 2, base_idx + 3))      # triangle 2
        
        # Second square faces 
        self.leaf_faces.append((base_idx + 4, base_idx + 5, base_idx + 6))  # triangle 3
        self.leaf_faces.append((base_idx + 4, base_idx + 6, base_idx + 7))  # triangle 4

# ---------- Reasonable defaults (feel free to tweak) ----------
def default_options(seed=1234) -> Options:
    levels = 2  # Simpler tree for testing
    return Options(
        seed=seed,
        type="Deciduous",
        branch=BranchSpec(
            levels=levels,
            length=[8.0, 4.0, 2.0],   # shorter tree
            radius=[0.4, 0.2, 0.1],
            sections=[6, 4, 3],        # fewer sections
            angle=[45.0, 35.0, 25.0],
            children=[2, 1, 0],        # fewer children
            start=[0.3, 0.5, 0.7],
            taper=[0.6, 0.8, 0.9],
            gnarliness=[0.02, 0.03, 0.04],
            twist=[0.04, 0.05, 0.06],
            force_dir=Vec3(0.1, 1.0, 0.1),
            force_strength=0.005,
        )
    )

# ---------- Plot ----------
def plot_wire(lines: List[Tuple[np.ndarray, np.ndarray, float, int]]):
    fig = plt.figure(figsize=(8, 10))
    ax = fig.add_subplot(111, projection='3d')

    # draw thicker lines for thicker radii
    max_r = max(r for _,_,r,_ in lines) if lines else 1.0
    for p0, p1, r, lvl in lines:
        x = [p0[0], p1[0]]; y = [p0[1], p1[1]]; z = [p0[2], p1[2]]
        lw = 0.5 + 2.5*(r/max_r)
        ax.plot(x, y, z, linewidth=lw, alpha=0.9, solid_capstyle='round')

    ax.set_box_aspect([1,1.6,1])  # taller in Y
    ax.set_xlabel('X'); ax.set_ylabel('Y'); ax.set_zlabel('Z')
    ax.view_init(elev=15, azim=45)
    plt.title('Procedural Tree (wireframe branches)')
    plt.tight_layout()
    plt.show()

def plot_3d_mesh(tree_gen: TreeWireframe):
    """Plot the tree as a 3D mesh using the cylindrical geometry"""
    fig = plt.figure(figsize=(12, 10))
    ax = fig.add_subplot(111, projection='3d')

    if not tree_gen.vertices or not tree_gen.faces:
        print("No 3D geometry generated")
        return

    # combine branch and leaf vertices/faces
    all_vertices = tree_gen.vertices + tree_gen.leaf_vertices
    
    # adjust leaf face indices to account for branch vertices
    branch_vertex_count = len(tree_gen.vertices)
    adjusted_leaf_faces = []
    for face in tree_gen.leaf_faces:
        adjusted_face = tuple(idx + branch_vertex_count for idx in face)
        adjusted_leaf_faces.append(adjusted_face)
    
    all_faces = tree_gen.faces + adjusted_leaf_faces

    # convert to arrays for plotting
    vertices = np.array([v for v in all_vertices])
    faces = np.array(all_faces)
    
    # create the 3D mesh
    from mpl_toolkits.mplot3d.art3d import Poly3DCollection
    
    # create triangular faces
    triangles = []
    colors = []
    
    branch_face_count = len(tree_gen.faces)
    
    for i, face in enumerate(faces):
        triangle = vertices[list(face)]
        triangles.append(triangle)
        
        if i < branch_face_count:
            # Branch faces - brown/bark colors based on height
            avg_y = np.mean(triangle[:, 1])
            colors.append(plt.cm.copper(0.3 + 0.4 * (avg_y / 20.0)))  # brown gradient
        else:
            # Leaf faces - green colors
            colors.append(plt.cm.Greens(0.7))  # green for leaves
    
    # create and add the mesh
    mesh = Poly3DCollection(triangles, alpha=0.8, edgecolor='black', linewidth=0.1)
    mesh.set_facecolors(colors)
    ax.add_collection3d(mesh)

    # set the plot limits based on the vertices
    if len(vertices) > 0:
        ax.set_xlim(vertices[:, 0].min() - 1, vertices[:, 0].max() + 1)
        ax.set_ylim(vertices[:, 1].min() - 1, vertices[:, 1].max() + 1)
        ax.set_zlim(vertices[:, 2].min() - 1, vertices[:, 2].max() + 1)

    ax.set_box_aspect([1,1.6,1])  # taller in Y
    ax.set_xlabel('X'); ax.set_ylabel('Y'); ax.set_zlabel('Z')
    ax.view_init(elev=15, azim=45)
    plt.title(f'Procedural Tree (3D Mesh - {len(vertices)} vertices, {len(faces)} faces, {len(tree_gen.leaf_vertices)} leaf vertices)')
    plt.tight_layout()
    plt.show()

def plot_voxels(voxel_grid, min_bounds, title="Voxelized Tree"):
    """Plot voxel grid as 3D scatter plot"""
    if voxel_grid is None:
        print("No voxel data to plot")
        return
        
    fig = plt.figure(figsize=(12, 10))
    ax = fig.add_subplot(111, projection='3d')
    
    # Get coordinates of non-empty voxels
    branch_coords = np.where(voxel_grid == 1)  # branches
    leaf_coords = np.where(voxel_grid == 2)    # leaves
    
    voxels_per_meter = 16
    
    # Convert voxel coordinates back to world coordinates
    if len(branch_coords[0]) > 0:
        branch_world = np.column_stack(branch_coords) / voxels_per_meter + min_bounds
        ax.scatter(branch_world[:, 0], branch_world[:, 1], branch_world[:, 2], 
                  c='brown', s=1, alpha=0.8, label=f'Branches ({len(branch_coords[0])} voxels)')
    
    if len(leaf_coords[0]) > 0:
        leaf_world = np.column_stack(leaf_coords) / voxels_per_meter + min_bounds
        ax.scatter(leaf_world[:, 0], leaf_world[:, 1], leaf_world[:, 2], 
                  c='green', s=1, alpha=0.8, label=f'Leaves ({len(leaf_coords[0])} voxels)')
    
    ax.set_xlabel('X (meters)')
    ax.set_ylabel('Y (meters)')
    ax.set_zlabel('Z (meters)')
    ax.legend()
    ax.set_title(title)
    
    # Set equal aspect ratio
    ax.set_box_aspect([1,1.6,1])
    plt.tight_layout()
    plt.show()
    
    # Print voxel statistics
    total_voxels = np.prod(voxel_grid.shape)
    branch_voxels = np.sum(voxel_grid == 1)
    leaf_voxels = np.sum(voxel_grid == 2)
    filled_voxels = branch_voxels + leaf_voxels
    
    print(f"Voxel Statistics:")
    print(f"  Grid size: {voxel_grid.shape} ({total_voxels:,} total voxels)")
    print(f"  Branch voxels: {branch_voxels:,}")
    print(f"  Leaf voxels: {leaf_voxels:,}")
    print(f"  Total filled: {filled_voxels:,} ({100*filled_voxels/total_voxels:.2f}%)")
    
    return branch_voxels, leaf_voxels

if __name__ == "__main__":
    opts = default_options(seed=1337)
    gen = TreeWireframe(opts)
    lines = gen.generate()
    
    # Show both wireframe and 3D mesh
    print(f"Generated tree with {len(gen.vertices)} branch vertices and {len(gen.faces)} branch faces")
    print(f"Generated {len(gen.leaf_vertices)} leaf vertices and {len(gen.leaf_faces)} leaf faces")
    print(f"Total: {len(gen.vertices) + len(gen.leaf_vertices)} vertices, {len(gen.faces) + len(gen.leaf_faces)} faces")
    print(f"Wireframe has {len(lines)} line segments")
    print(f"Skipped {gen.skipped_count} degenerate sections")
    
    # Debug: check radius distribution
    radii = [r for _, _, r, _ in lines]
    print(f"Radius range: {min(radii):.6f} to {max(radii):.3f}")
    print(f"Number of very thin segments (< 0.01): {sum(1 for r in radii if r < 0.01)}")
    
    print("\n" + "="*50)
    print("VOXELIZING TREE...")
    print("="*50)
    
    # Voxelize the tree (start with lower resolution for testing)
    voxel_grid, min_bounds = gen.voxelize(target_height_meters=10.0, voxels_per_meter=4)
    
    # Show results
    if voxel_grid is not None:
        plot_voxels(voxel_grid, min_bounds, "10m Tree at 4 voxels/meter")
    else:
        print("Voxelization failed!")
    
    # Also show the original mesh for comparison
    # plot_3d_mesh(gen)
