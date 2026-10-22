/**
 * 三维点云的布局计算：双环同心结构 + 力导向收敛。
 *
 * 结构参考 Orbitgraph 的「双环同心圆」：内环是知识、外环是挂在它上面的实例。
 * 映射到文献图谱：
 *   - **核心环（core）**：被 ≥2 篇论文共享的实体——跨文献才是真正沉淀下来的知识，
 *     被越多篇共享越靠圆心（这就是 Orbitgraph 里「标签越核心越靠内」的对应物）；
 *   - **外围环（outer）**：只出现在一篇里的实体；
 *   - **论文壳（paper）**：论文本身摆在外圈球壳上，各连到自己包含的实体——
 *     对应 Orbitgraph 外环的题目。
 *
 * 为什么是「收敛后静止」而不是一直抖的实时模拟：
 *   力导向每帧全量重算在几千个点上很贵，而点云要回答的是「结构长什么样」，
 *   不是在动。所以这里迭代到冷却就冻结，旋转交给相机。
 *
 * 确定性：初始位置由节点 id 哈希播种，力累加按索引顺序、固定步长，
 * 同一份图谱每次收敛到同一朵云（分帧计算不改变结果，只影响什么时候算完）。
 */

export type CloudRing = 'core' | 'outer' | 'paper';

export interface CloudInputNode {
  id: string;
  label: string;
  kind: string;
  /** 该实体出现在哪些论文里；长度决定它落在哪一环。 */
  docs: string[];
}

export interface CloudInputEdge {
  id: string;
  from: string;
  to: string;
  label: string;
  docs: string[];
}

export interface CloudInputPaper {
  key: string;
  title: string;
}

export interface CloudNode {
  id: string;
  label: string;
  kind: string;
  ring: CloudRing;
  docs: string[];
  share: number;
  degree: number;
  size: number;
  x: number;
  y: number;
  z: number;
  /** 该节点被指定的目标半径（收敛时拉向它，决定环的形状）。 */
  targetRadius: number;
}

export interface CloudLink {
  id: string;
  from: number;
  to: number;
  kind: 'relation' | 'member';
  label: string;
  docs: string[];
}

export interface CloudLayout {
  nodes: CloudNode[];
  links: CloudLink[];
  /** 外圈半径：相机取景与缩放范围按它算。 */
  radius: number;
  stats: {
    core: number;
    outer: number;
    papers: number;
    relations: number;
    members: number;
    iterations: number;
    converged: boolean;
  };
}

export interface CloudLayoutOptions {
  /** 基础半径，实际半径按节点数微调。默认 100。 */
  radius?: number;
  /** 最大迭代轮数（每轮是一整步力累加）。默认按节点数自适应。 */
  maxIterations?: number;
  /**
   * 收敛判据：单轮最大位移小于「半径 × 该比例」即认为稳定。默认 0.004。
   *
   * 实测位移衰减到半径的 0.2%–0.6% 就进入平台期不再下降——环约束与弹簧互相顶着，
   * 会一直有肉眼看不见的残留微动。所以判据是**相对半径**的，绝对阈值永远等不到。
   */
  epsilon?: number;
  /** 单轮内参与斥力计算的实体数上限（默认 300）：超过就按步长抽样，避免 O(n²) 爆掉。 */
  repulsionSample?: number;
}

/** FNV-1a：只用来把 id 变成稳定的初始位置，不用于任何安全用途。 */
function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** 由哈希得到 [0,1) 的稳定伪随机数（同一 seed 序列可复现）。 */
function seededUnit(seed: number, salt: number): number {
  let value = (seed ^ Math.imul(salt + 1, 0x9e3779b9)) >>> 0;
  value = Math.imul(value ^ (value >>> 15), 0x85ebca6b) >>> 0;
  value = Math.imul(value ^ (value >>> 13), 0xc2b2ae35) >>> 0;
  return ((value ^ (value >>> 16)) >>> 0) / 4294967296;
}

/**
 * 收敛一轮力导向。分帧调用时 rank 状态由调用方持有，本函数只推进一步。
 */
function step(
  nodes: CloudNode[],
  links: CloudLink[],
  velocity: Float64Array,
  radius: number,
  sampleStride: number,
): number {
  const count = nodes.length;
  const forceX = new Float64Array(count);
  const forceY = new Float64Array(count);
  const forceZ = new Float64Array(count);
  // 累加走小工具函数：Float64Array 的下标读取在 noUncheckedIndexedAccess 下是可选值，
  // 直接 `forceX[i] += ...` 会到处撒非空断言；集中到这里一次说清楚。
  const add = (target: Float64Array, index: number, value: number) => {
    target[index] = (target[index] ?? 0) + value;
  };

  // 1) 斥力：实体之间互推。论文壳节点不参与（它们靠环约束与成员弹簧定位，
  //    再叠斥力会让外壳被撑成不均匀的疙瘩）。
  // 步长越大，本轮参与斥力计算的对象越少；按步长放大单次贡献，近似补回被抽掉的对象。
  const repulsion = radius * radius * 0.06 * sampleStride;
  const cutoff = radius * 1.2;
  const cutoffSq = cutoff * cutoff;
  for (let i = 0; i < count; i += 1) {
    if (nodes[i]!.ring === 'paper') continue;
    // 大图按确定性步长均匀抽样。旧实现仍遍历全部 j，只额外抽一个点，实际复杂度仍是 O(n²)。
    for (let j = i + 1; j < count; j += sampleStride) {
      const other = nodes[j]!;
      if (other.ring === 'paper') continue;
      const dx = nodes[i]!.x - other.x;
      const dy = nodes[i]!.y - other.y;
      const dz = nodes[i]!.z - other.z;
      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq > cutoffSq || distSq < 1e-9) continue;
      const scale = repulsion / distSq;
      const inv = 1 / Math.sqrt(distSq);
      add(forceX, i, dx * inv * scale);
      add(forceY, i, dy * inv * scale);
      add(forceZ, i, dz * inv * scale);
      add(forceX, j, -dx * inv * scale);
      add(forceY, j, -dy * inv * scale);
      add(forceZ, j, -dz * inv * scale);
    }
  }

  // 2) 关系与成员弹簧：关系边把它拉近，成员边把论文与其实体拉住。
  for (const link of links) {
    const a = nodes[link.from]!;
    const b = nodes[link.to]!;
    let rest: number;
    let strength: number;
    if (link.kind === 'relation') {
      rest = radius * 0.32;
      strength = 0.045;
    } else {
      // 成员弹簧的静息长度取「论文壳半径 − 该实体的目标半径」：
      // 这样每个点都在自己该在的壳上时弹簧恰好不受力。若用固定长度，
      // 论文节点会被一堆成员边整体拽向圆心，外圈直接塌掉（实测就是这样）。
      const entity = a.ring === 'paper' ? b : a;
      const paper = a.ring === 'paper' ? a : b;
      rest = Math.max(radius * 0.12, Math.abs(paper.targetRadius - entity.targetRadius));
      strength = 0.02;
    }
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
    const pull = ((dist - rest) / dist) * strength;
    const fx = dx * pull;
    const fy = dy * pull;
    const fz = dz * pull;
    add(forceX, link.from, fx);
    add(forceY, link.from, fy);
    add(forceZ, link.from, fz);
    add(forceX, link.to, -fx);
    add(forceY, link.to, -fy);
    add(forceZ, link.to, -fz);
  }

  // 3) 环约束：把每个点拉回它该在的球壳。这是「同心」的来源，权重压过弹簧。
  for (let index = 0; index < count; index += 1) {
    const node = nodes[index]!;
    const dist = Math.sqrt(node.x * node.x + node.y * node.y + node.z * node.z) || 1e-6;
    const strength = node.ring === 'paper' ? 0.16 : 0.09;
    const pull = ((dist - node.targetRadius) / dist) * strength;
    add(forceX, index, -node.x * pull);
    add(forceY, index, -node.y * pull);
    add(forceZ, index, -node.z * pull);
  }

  // 4) 积分（固定步长 + 阻尼），返回本轮最大位移。
  let maxStep = 0;
  for (let index = 0; index < count; index += 1) {
    const offset = index * 3;
    velocity[offset] = ((velocity[offset] ?? 0) + (forceX[index] ?? 0)) * 0.86;
    velocity[offset + 1] = ((velocity[offset + 1] ?? 0) + (forceY[index] ?? 0)) * 0.86;
    velocity[offset + 2] = ((velocity[offset + 2] ?? 0) + (forceZ[index] ?? 0)) * 0.86;
    const dx = velocity[offset] ?? 0;
    const dy = velocity[offset + 1] ?? 0;
    const dz = velocity[offset + 2] ?? 0;
    nodes[index]!.x += dx;
    nodes[index]!.y += dy;
    nodes[index]!.z += dz;
    const moved = Math.abs(dx) + Math.abs(dy) + Math.abs(dz);
    if (moved > maxStep) maxStep = moved;
  }
  return maxStep;
}

/** 建好节点与连边、算出目标半径，但还没有跑力导向。 */
export function prepareCloud(
  input: { nodes: CloudInputNode[]; edges: CloudInputEdge[]; papers: CloudInputPaper[] },
  options: CloudLayoutOptions = {},
): CloudLayout {
  const { nodes: inputNodes, edges: inputEdges, papers } = input;
  const radius = options.radius ?? 100;
  const maxShare = inputNodes.reduce((max, node) => Math.max(max, node.docs.length), 1);
  const degree = new Map<string, number>();
  for (const edge of inputEdges) {
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
  }

  const nodes: CloudNode[] = inputNodes.map((node) => {
    const share = Math.max(1, node.docs.length);
    const seed = hashString(node.id);
    const connections = degree.get(node.id) ?? 0;
    // 共享篇数决定落环：≥2 篇进核心环，被越多篇共享越靠圆心。
    const ring: CloudRing = share >= 2 ? 'core' : 'outer';
    const inner = 0.3 + 0.32 * (1 - (share - 2) / Math.max(1, maxShare - 1));
    const outer = 0.72 + 0.26 * seededUnit(seed, 7);
    const targetRadius = (ring === 'core' ? inner : outer) * radius;
    // 初始位置：球面均匀采样（由哈希决定角度），半径加上一点抖动。
    const theta = seededUnit(seed, 1) * Math.PI * 2;
    const phi = Math.acos(2 * seededUnit(seed, 2) - 1);
    const r = targetRadius * (0.75 + 0.5 * seededUnit(seed, 3));
    return {
      id: node.id,
      label: node.label,
      kind: node.kind,
      ring,
      docs: node.docs,
      share,
      degree: connections,
      // 度数取对数：连得多的点大一些，但不至于一个超级节点吃掉整个画面。
      size: 1 + Math.min(2.4, Math.log2(1 + connections) * 0.55),
      x: r * Math.sin(phi) * Math.cos(theta),
      y: r * Math.sin(phi) * Math.sin(theta),
      z: r * Math.cos(phi),
      targetRadius,
    };
  });

  const indexById = new Map(nodes.map((node, index) => [node.id, index]));
  const links: CloudLink[] = [];
  for (const edge of inputEdges) {
    const from = indexById.get(edge.from);
    const to = indexById.get(edge.to);
    // 端点可能被筛选掉了：这种边不画，但也不静默改成别的端点。
    if (from === undefined || to === undefined || from === to) continue;
    links.push({ id: edge.id, from, to, kind: 'relation', label: edge.label, docs: edge.docs });
  }

  // 论文节点摆在外壳：它们不是抽取出来的实体，是本地的文献。
  const paperRadius = radius * (1 + 0.05 * Math.min(1, papers.length / 12));
  papers.forEach((paper, position) => {
    const seed = hashString(`paper:${paper.key}`);
    const theta = (position / Math.max(1, papers.length)) * Math.PI * 2 + seededUnit(seed, 4) * 0.3;
    const phi = Math.acos(1 - 2 * ((position + 0.5) / Math.max(1, papers.length)));
    const jitter = 0.94 + 0.12 * seededUnit(seed, 5);
    const r = paperRadius * jitter;
    nodes.push({
      id: `paper:${paper.key}`,
      label: paper.title || paper.key,
      kind: 'paper',
      ring: 'paper',
      docs: [paper.key],
      share: 1,
      degree: 0,
      size: 2.1,
      x: r * Math.sin(phi) * Math.cos(theta),
      y: r * Math.sin(phi) * Math.sin(theta),
      z: r * Math.cos(phi),
      targetRadius: paperRadius,
    });
  });

  // 成员边：论文 → 它包含的实体。这一步让外环「挂」在内环上。
  const paperIndexByKey = new Map<string, number>();
  nodes.forEach((node, index) => {
    if (node.ring === 'paper') paperIndexByKey.set(node.docs[0]!, index);
  });
  let members = 0;
  nodes.forEach((node, index) => {
    if (node.ring === 'paper') return;
    for (const key of node.docs) {
      const paperIndex = paperIndexByKey.get(key);
      if (paperIndex === undefined) continue;
      links.push({
        id: `member:${key}:${node.id}`,
        from: paperIndex,
        to: index,
        kind: 'member',
        label: '包含',
        docs: [key],
      });
      members += 1;
    }
  });

  return {
    nodes,
    links,
    radius: paperRadius,
    stats: {
      core: nodes.filter((node) => node.ring === 'core').length,
      outer: nodes.filter((node) => node.ring === 'outer').length,
      papers: papers.length,
      relations: links.length - members,
      members,
      iterations: 0,
      converged: false,
    },
  };
}

export function defaultIterations(nodeCount: number): number {
  // 迭代轮数随规模下降：大图上单轮更贵，宁可少跑几轮也不要卡住界面。
  return Math.round(Math.min(320, Math.max(60, 4200 / Math.sqrt(Math.max(4, nodeCount)))));
}

/** 收敛一步；分帧调用方按 maxIterations/epsilon 自行决定何时停。 */
export function advanceCloud(
  layout: CloudLayout,
  velocity: Float64Array,
  options: CloudLayoutOptions = {},
): number {
  const radius = layout.radius;
  const sampleStride = Math.max(
    1,
     Math.ceil(layout.nodes.length / Math.max(64, options.repulsionSample ?? 300)),
  );
  const moved = step(layout.nodes, layout.links, velocity, radius, sampleStride);
  layout.stats.iterations += 1;
  return moved;
}

/** 一次性算完（测试与小图用它；界面走分帧版本以免阻塞）。 */
export function layoutCloud(
  input: { nodes: CloudInputNode[]; edges: CloudInputEdge[]; papers: CloudInputPaper[] },
  options: CloudLayoutOptions = {},
): CloudLayout {
  const layout = prepareCloud(input, options);
  const velocity = new Float64Array(layout.nodes.length * 3);
  const maxIterations = options.maxIterations ?? defaultIterations(layout.nodes.length);
  const epsilon = (options.epsilon ?? 0.004) * layout.radius;
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const moved = advanceCloud(layout, velocity, options);
    if (moved < epsilon) {
      layout.stats.converged = true;
      break;
    }
  }
  return layout;
}

/** 界面用的收敛判据：与 layoutCloud 保持同一个阈值口径。 */
export function convergenceThreshold(layout: CloudLayout, options: CloudLayoutOptions = {}): number {
  return (options.epsilon ?? 0.004) * layout.radius;
}
