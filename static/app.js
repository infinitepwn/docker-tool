const $ = (selector) => document.querySelector(selector);
const viewport = $('#viewport');
const world = $('#world');
const nodeLayer = $('#nodes');
const edgeLayer = $('#edges');
const STORAGE_KEY = 'topology-lab-v1';
const TOPOLOGY_FORMAT = 'topology-lab';
const TOPOLOGY_VERSION = 1;
const GUI_USERNAME = 'kasm_user';
const SERVER_USERNAME = 'lab';
const TYPE_LABEL = { client: '客户端', router: '路由器', server: '服务器', switch: '交换机' };
const TYPE_ICON = { client: '⌘', router: '◇', server: '▣', switch: '▦' };
const NODE_W = 154, NODE_H = 100;
let topology = loadTopology();
let selection = null;
let pendingSource = null;
let connectMode = false;
let transform = { x: 65, y: 80, scale: 1 };
let dragging = null;
let generated = null;
let activeFile = null;
let toastTimer;
let linkedDirectory = null;
let syncTimer = null;
let syncInFlight = false;
let syncPending = false;
let revision = 0;
let nativePickerAvailable = false;
const PROJECT_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;

function randomPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return Array.from(bytes, value => alphabet[value % alphabet.length]).join('');
}
function randomProjectName() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return `topology-lab-${Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('')}`;
}
function syncPasswords(document) {
  if (typeof document.projectName !== 'string' || !PROJECT_NAME_PATTERN.test(document.projectName)) document.projectName = randomProjectName();
  if (document.nodes.some(node => node.gui)) {
    if (typeof document.guiPassword !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(document.guiPassword)) document.guiPassword = randomPassword();
  } else delete document.guiPassword;
  if (document.nodes.some(node => node.type === 'server')) {
    if (typeof document.serverPassword !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(document.serverPassword)) document.serverPassword = randomPassword();
  } else delete document.serverPassword;
  return document;
}
function demoTopology() {
  return {
    nodes: [
      { id: 'client-1', name: '客户端 A', type: 'client', x: 100, y: 190 },
      { id: 'router-1', name: '核心路由器', type: 'router', x: 390, y: 190 },
      { id: 'server-1', name: 'Web 服务器', type: 'server', x: 680, y: 190 },
    ],
    links: [
      { id: 'link-1', source: 'client-1', target: 'router-1', subnet: '10.200.1.0/24', sourceIp: '10.200.1.10', targetIp: '10.200.1.11', sourceMac: '02:42:c8:00:01:01', targetMac: '02:42:c8:00:01:02' },
      { id: 'link-2', source: 'router-1', target: 'server-1', subnet: '10.200.2.0/24', sourceIp: '10.200.2.10', targetIp: '10.200.2.11', sourceMac: '02:42:c8:00:02:01', targetMac: '02:42:c8:00:02:02' },
    ],
  };
}
function loadTopology() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved && Array.isArray(saved.nodes) && Array.isArray(saved.links)) return syncPasswords(saved);
  } catch (_) {}
  return syncPasswords(demoTopology());
}
function save() { syncPasswords(topology); localStorage.setItem(STORAGE_KEY, JSON.stringify(topology)); generated = null; revision++; $('#projectNameInput').value = topology.projectName; $('#fileTitle').textContent = activeFile ? `${activeFile} · 需刷新` : '选择文件查看内容'; scheduleLocalSync(); }
function topologyDocument() {
  const document = {format: TOPOLOGY_FORMAT, version: TOPOLOGY_VERSION, savedAt: new Date().toISOString(), projectName: topology.projectName, viewport: {...transform}, nodes: topology.nodes, links: topology.links};
  if (topology.guiPassword) document.guiPassword = topology.guiPassword;
  if (topology.serverPassword) document.serverPassword = topology.serverPassword;
  return document;
}
function topologyFilename() {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
  return `network-topology-${stamp}.json`;
}
function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob); const anchor = document.createElement('a');
  anchor.href = url; anchor.download = filename; document.body.appendChild(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
async function saveTopologyFile() {
  const body = JSON.stringify(topologyDocument(), null, 2) + '\n';
  try {
    if (typeof window.showSaveFilePicker === 'function') {
      const handle = await window.showSaveFilePicker({id:'topology-json', suggestedName:topologyFilename(), types:[{description:'网络拓扑 JSON', accept:{'application/json':['.json']}}]});
      const writable = await handle.createWritable();
      try { await writable.write(body); await writable.close(); }
      catch (error) { try { await writable.abort(); } catch (_) {} throw error; }
    } else triggerDownload(new Blob([body], {type:'application/json'}), topologyFilename());
    toast('当前网络拓扑已保存');
  } catch (error) { if (error.name !== 'AbortError') toast(`保存拓扑失败：${error.message}`); }
}
function validateTopologyDocument(document) {
  if (!document || typeof document !== 'object') throw new Error('拓扑文件格式错误');
  if (document.format && document.format !== TOPOLOGY_FORMAT) throw new Error('这不是拓扑工坊文件');
  if (document.version !== undefined && document.version !== TOPOLOGY_VERSION) throw new Error(`不支持的拓扑文件版本：${document.version}`);
  if (!Array.isArray(document.nodes) || !Array.isArray(document.links)) throw new Error('拓扑文件缺少 nodes 或 links');
  const projectName = document.projectName === undefined ? randomProjectName() : document.projectName;
  if (typeof projectName !== 'string' || !PROJECT_NAME_PATTERN.test(projectName)) throw new Error('Compose 项目名无效');
  if (document.nodes.length > 80 || document.links.length > 160) throw new Error('拓扑规模超过限制');
  const ids = new Set();
  const nodes = document.nodes.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id.trim() || raw.id.length > 80 || ids.has(raw.id) || !TYPE_LABEL[raw.type]) throw new Error(`第 ${index + 1} 个节点无效`);
    if (raw.name !== undefined && (typeof raw.name !== 'string' || raw.name.length > 200)) throw new Error(`第 ${index + 1} 个节点名称无效`);
    ids.add(raw.id);
    const x = Number.isFinite(Number(raw.x)) ? Number(raw.x) : 120 + index * 35;
    const y = Number.isFinite(Number(raw.y)) ? Number(raw.y) : 160 + index * 25;
    const node = {id:raw.id, name:typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : raw.id, type:raw.type, gui:(raw.type === 'client' || raw.type === 'server') && raw.gui === true, x:Math.max(0, Math.min(2240, x)), y:Math.max(0, Math.min(1520, y))};
    if (raw.mirror !== undefined && raw.mirror !== null) {
      if (raw.type !== 'router' || !raw.mirror || typeof raw.mirror !== 'object' || ['source','target','destination'].some(field => typeof raw.mirror[field] !== 'string')) throw new Error(`第 ${index + 1} 个节点的流量镜像配置无效`);
      node.mirror = {source:raw.mirror.source, target:raw.mirror.target, destination:raw.mirror.destination};
    }
    return node;
  });
  const linkIds = new Set();
  const links = document.links.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id.trim() || raw.id.length > 80 || linkIds.has(raw.id) || !ids.has(raw.source) || !ids.has(raw.target) || raw.source === raw.target) throw new Error(`第 ${index + 1} 条连线无效`);
    const fields = ['subnet','sourceIp','targetIp','sourceMac','targetMac'];
    if (fields.some(field => raw[field] !== undefined && (typeof raw[field] !== 'string' || raw[field].length > 200))) throw new Error(`第 ${index + 1} 条连线配置无效`);
    linkIds.add(raw.id);
    return {id:raw.id, source:raw.source, target:raw.target, subnet:raw.subnet || '', sourceIp:raw.sourceIp || '', targetIp:raw.targetIp || '', sourceMac:raw.sourceMac || '', targetMac:raw.targetMac || ''};
  });
  if (nodes.some(node => node.mirror && new Set(Object.values(node.mirror)).size !== 3)) throw new Error('流量镜像需要三个不同节点');
  let guiPassword = document.guiPassword;
  if (nodes.some(node => node.gui)) {
    if (guiPassword === undefined) guiPassword = randomPassword();
    else if (typeof guiPassword !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(guiPassword)) throw new Error('GUI 密码格式无效');
  } else guiPassword = null;
  let serverPassword = document.serverPassword;
  if (nodes.some(node => node.type === 'server')) {
    if (serverPassword === undefined) serverPassword = randomPassword();
    else if (typeof serverPassword !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(serverPassword)) throw new Error('服务器密码格式无效');
  } else serverPassword = null;
  const view = document.viewport;
  const viewportState = view && [view.x, view.y, view.scale].every(value => Number.isFinite(Number(value))) ? {x:Number(view.x), y:Number(view.y), scale:Math.max(.45, Math.min(1.7, Number(view.scale)))} : null;
  return {nodes, links, viewportState, projectName, guiPassword, serverPassword};
}
async function chooseTopologyFile() {
  if (typeof window.showOpenFilePicker === 'function') {
    const [handle] = await window.showOpenFilePicker({id:'topology-json', multiple:false, types:[{description:'网络拓扑 JSON', accept:{'application/json':['.json']}}]});
    return handle.getFile();
  }
  return new Promise(resolve => {
    const input = $('#topologyFileInput'); input.value = '';
    input.onchange = () => resolve(input.files?.[0] || null); input.click();
  });
}
async function openTopologyFile() {
  try {
    const file = await chooseTopologyFile(); if (!file) return;
    if (file.size > 2_000_000) throw new Error('拓扑文件不能超过 2 MB');
    const parsed = validateTopologyDocument(JSON.parse(await file.text()));
    topology = {projectName:parsed.projectName, nodes:parsed.nodes, links:parsed.links};
    if (parsed.guiPassword) topology.guiPassword = parsed.guiPassword;
    if (parsed.serverPassword) topology.serverPassword = parsed.serverPassword;
    selection = null; stopConnecting(); save(); render();
    if (parsed.viewportState) { transform = parsed.viewportState; renderTransform(); } else fitView();
    toast(`已打开拓扑：${file.name}`);
  } catch (error) { if (error.name !== 'AbortError') toast(`打开拓扑失败：${error.message}`); }
}
function esc(value) { return String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function toast(message) { const el = $('#toast'); el.textContent = message; el.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 3200); }
function nextId(prefix, values) { let n = 1; while (values.some(item => item.id === `${prefix}-${n}`)) n++; return `${prefix}-${n}`; }
function worldPoint(clientX, clientY) { const rect = viewport.getBoundingClientRect(); return { x: (clientX - rect.left - transform.x) / transform.scale, y: (clientY - rect.top - transform.y) / transform.scale }; }
function renderTransform() { world.style.transform = `translate(${transform.x}px,${transform.y}px) scale(${transform.scale})`; $('#zoomLabel').textContent = `${Math.round(transform.scale * 100)}%`; }
function nodeById(id) { return topology.nodes.find(n => n.id === id); }
function degree(id) { return topology.links.filter(l => l.source === id || l.target === id).length; }
function guiPort(id) { return 6901 + topology.nodes.filter(node => node.gui).findIndex(node => node.id === id); }
function canConnect(id) { const n = nodeById(id); return n && (n.type === 'router' || n.type === 'switch' || degree(id) === 0); }
function chooseSource(id) {
  if (!canConnect(id)) { toast('客户端和服务器只能连接一条线，请通过交换机连接多个设备'); return; }
  pendingSource = id; connectMode = true; $('#connectBtn').classList.add('active'); viewport.classList.add('connecting'); $('#canvasHint').textContent = `已选择 ${nodeById(id).name}，点击目标节点完成连接 · Esc 取消`;
  renderNodes();
}
function stopConnecting() { pendingSource = null; connectMode = false; $('#connectBtn').classList.remove('active'); viewport.classList.remove('connecting'); $('#canvasHint').textContent = '拖动节点布局 · 点击节点侧边的连接点创建连线'; renderNodes(); }
function nodeKind(id) { return nodeById(id)?.type; }
  function switchFamily(id) {
    const family = new Set([id]), todo = [id];
    while (todo.length) {
      const current = todo.pop();
      for (const l of topology.links) {
        if (nodeKind(l.source) !== 'switch' || nodeKind(l.target) !== 'switch') continue;
        const next = l.source === current ? l.target : l.target === current ? l.source : null;
        if (next && !family.has(next)) {family.add(next); todo.push(next);}
      }
    }
    return family;
  }
  function groupLinkIds(link) {
    const switches = [link.source, link.target].filter(id => nodeKind(id) === 'switch');
    if (!switches.length) return new Set([link.id]);
    const family = switchFamily(switches[0]);
    return new Set(topology.links.filter(l => family.has(l.source) || family.has(l.target)).map(l => l.id));
  }
  function groupForSwitch(id) {
    const family = switchFamily(id);
    return topology.links.filter(l => family.has(l.source) || family.has(l.target));
  }
  const uniqueSubnets = () => [...new Set(topology.links.map(l => l.subnet))];
  function newSubnet() {
    const used = uniqueSubnets();
    for (let n = 1; n < 255; n++) {const cidr = `10.200.${n}.0/24`; if (!used.includes(cidr)) return cidr;}
    throw new Error('自动分配网段已用尽，请手动编辑连线网段。');
  }
  function ipv4Number(ip) {
    if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) return null;
    const a = ip.split('.').map(Number);
    if (a.some(v => v > 255)) return null;
    return (((a[0] * 0x1000000) + (a[1] << 16) + (a[2] << 8) + a[3]) >>> 0);
  }
  const ipv4Text = n => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
  function subnetRange(cidr) {
    const [ip, prefixText] = String(cidr).split('/');
    const n = ipv4Number(ip), prefix = Number(prefixText);
    if (n === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 29 || prefixText === undefined) return null;
    const size = 2 ** (32 - prefix), start = Math.floor(n / size) * size;
    if (start !== n) return null;
    return {start, end:start + size - 1, size};
  }
  function unusedIp(subnet, used) {
    const range = subnetRange(subnet);
    if (!range) throw new Error('网段格式错误：示例 10.200.1.0/24（最窄 /29）');
    const first = range.start + (range.size > 12 ? 10 : 2);
    for (let candidate = first; candidate < range.end; candidate++) {
      const value = ipv4Text(candidate);
      if (candidate !== range.start + 1 && !used.has(value)) {used.add(value); return value;}
    }
    for (let candidate = range.start + 2; candidate < first; candidate++) {
      const value = ipv4Text(candidate);
      if (!used.has(value)) {used.add(value); return value;}
    }
    throw new Error(`${subnet} 的可用地址不足，请改用更大的子网。`);
  }
  function newMac(extra = []) {
    const used = new Set([...topology.links.flatMap(l => [l.sourceMac, l.targetMac].filter(Boolean)), ...extra].map(v => v.toLowerCase()));
    for (let n = 1; n < 65535; n++) {
      const mac = `02:42:ac:11:${((n >> 8) & 255).toString(16).padStart(2,'0')}:${(n & 255).toString(16).padStart(2,'0')}`;
      if (!used.has(mac)) return mac;
    }
    throw new Error('MAC 地址已用尽');
  }
  function readdress(linkIds, subnet) {
    const range = subnetRange(subnet);
    if (!range) throw new Error('网段格式错误，请输入例如 10.200.1.0/24');
    const otherUsed = new Set();
    for (const l of topology.links) if (!linkIds.has(l.id)) for (const side of ['source','target']) if (l[side+'Ip']) otherUsed.add(l[side+'Ip']);
    const modifications = [];
    for (const l of topology.links) if (linkIds.has(l.id)) {
      modifications.push([l,'subnet',subnet]);
      for (const side of ['source','target']) if (nodeKind(l[side]) !== 'switch') modifications.push([l,side+'Ip',unusedIp(subnet, otherUsed)]);
    }
    for (const [link, field, value] of modifications) link[field] = value;
  }
  function createLink(a, b) {
    if (a === b) throw new Error('不能连接节点自身');
    if (topology.links.some(l => (l.source===a && l.target===b) || (l.source===b && l.target===a))) throw new Error('这两个节点已经连接');
    for (const id of [a,b]) if (['client','server'].includes(nodeKind(id)) && topology.links.some(l => l.source===id || l.target===id)) throw new Error('客户端和服务器只能连接一条线；请通过交换机连接多台设备。');
    const switchA = nodeKind(a)==='switch', switchB = nodeKind(b)==='switch';
    if (!switchA && !switchB && a===b) throw new Error('无效连接');
    let subnet;
    if (switchA || switchB) {
      const first = switchA ? groupForSwitch(a) : [];
      const second = switchB ? groupForSwitch(b) : [];
      subnet = first[0]?.subnet || second[0]?.subnet || newSubnet();
      if (switchA && !switchB && first.some(l => l.source===b || l.target===b) ||
          switchB && !switchA && second.some(l => l.source===a || l.target===a)) throw new Error('该设备已连接到同一个交换机网段，不能重复接入');
      if (switchA && switchB && switchFamily(a).has(b)) throw new Error('这两台交换机已经处于同一个二层网段');
    } else subnet = newSubnet();
    const result = {id:nextId('link', topology.links),source:a,target:b,subnet,sourceIp:'',targetIp:'',sourceMac:'',targetMac:''};
    const ips = new Set(topology.links.flatMap(l => [l.sourceIp,l.targetIp]).filter(Boolean));
    for (const side of ['source','target']) if (nodeKind(result[side]) !== 'switch') {
      result[side+'Ip'] = unusedIp(subnet, ips);
      result[side+'Mac'] = newMac([result.sourceMac, result.targetMac]);
    }
    topology.links.push(result);
    if (switchA && switchB) {
      const ids = groupLinkIds(result);
      const ranges = new Set([...ids].map(id => topology.links.find(l => l.id===id).subnet));
      if (ranges.size > 1) readdress(ids, subnet);
    }
    selection = {kind:'link', id:result.id}; save(); stopConnecting(); render(); toast(`已连接：${subnet}`);
  }

function newLink(source, target) {
  try { createLink(source, target); }
  catch (error) { toast(error.message); }
}

function addNode(type, x, y) {
  const id = nextId(type, topology.nodes);
  const count = topology.nodes.filter(n => n.type === type).length + 1;
  const occupied = (px, py) => topology.nodes.some(n => Math.abs(n.x - px) < NODE_W + 25 && Math.abs(n.y - py) < NODE_H + 22);
  if (occupied(x, y)) {
    outer: for (let ring = 1; ring < 12; ring++) {
      for (let dx = -ring; dx <= ring; dx++) for (let dy = -ring; dy <= ring; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        const px = Math.max(10, x + dx * 195), py = Math.max(10, y + dy * 115);
        if (!occupied(px, py)) { x = px; y = py; break outer; }
      }
    }
  }
  topology.nodes.push({ id, name: `${TYPE_LABEL[type]} ${count}`, type, gui: false, x: Math.max(10, Math.min(2200, x)), y: Math.max(10, Math.min(1480, y)) });
  selection = { kind: 'node', id }; save(); render();
}
function nodeIps(node) {
  if (node.type === 'switch') { const links = groupForSwitch(node.id); return links.length ? [links[0].subnet] : ['二层交换机 · 无 IP']; }
  const ips = [];
  for (const link of topology.links) {
    if (link.source === node.id && link.sourceIp) ips.push(link.sourceIp);
    if (link.target === node.id && link.targetIp) ips.push(link.targetIp);
  }
  return ips.length ? ips : ['未分配 IP'];
}
function renderNodes() {
  nodeLayer.replaceChildren();
  for (const node of topology.nodes) {
    const el = document.createElement('div');
    el.className = `topology-node ${node.type}${selection?.kind === 'node' && selection.id === node.id ? ' selected' : ''}${pendingSource === node.id ? ' pending' : ''}`;
    el.style.left = `${Number(node.x) || 0}px`; el.style.top = `${Number(node.y) || 0}px`; el.dataset.nodeId = node.id;
    el.innerHTML = `<span class="node-icon">${TYPE_ICON[node.type] || '?'}</span><span class="node-copy"><strong>${esc(node.name)}</strong><span>${TYPE_LABEL[node.type] || node.type}${node.gui ? ' · GUI' : ''} · ${degree(node.id)} 条连接</span><span class="node-ips">${nodeIps(node).map(ip => `<small>${esc(ip)}</small>`).join('')}</span></span><span class="node-port" title="从此节点连接"></span>`;
    el.querySelector('.node-port').addEventListener('pointerdown', event => event.stopPropagation());
    el.querySelector('.node-port').addEventListener('click', event => { event.stopPropagation(); if (pendingSource) newLink(pendingSource, node.id); else chooseSource(node.id); });
    el.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      event.stopPropagation();
      if (pendingSource) { newLink(pendingSource, node.id); return; }
      if (connectMode) { chooseSource(node.id); return; }
      selection = { kind: 'node', id: node.id }; renderInspector(); renderNodes();
      const point = worldPoint(event.clientX, event.clientY);
      dragging = { kind: 'node', id: node.id, dx: point.x - node.x, dy: point.y - node.y };
      viewport.setPointerCapture(event.pointerId);
    });
    nodeLayer.appendChild(el);
  }
}
function renderEdges() {
  edgeLayer.replaceChildren();
  for (const link of topology.links) {
    const a = nodeById(link.source), b = nodeById(link.target);
    if (!a || !b) continue;
    const x1 = Number(a.x) + NODE_W / 2, y1 = Number(a.y) + NODE_H / 2;
    const x2 = Number(b.x) + NODE_W / 2, y2 = Number(b.y) + NODE_H / 2;
    const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    const visible = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    visible.setAttribute('x1', x1); visible.setAttribute('y1', y1); visible.setAttribute('x2', x2); visible.setAttribute('y2', y2);
    visible.setAttribute('class', `edge-visible${selection?.kind === 'link' && selection.id === link.id ? ' edge-selected' : ''}`);
    const hit = visible.cloneNode(); hit.setAttribute('class', 'edge-hit');
    hit.addEventListener('pointerdown', event => { event.stopPropagation(); selection = { kind: 'link', id: link.id }; render(); });
    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('x', (x1 + x2) / 2); label.setAttribute('y', (y1 + y2) / 2 - 10);
    label.setAttribute('text-anchor', 'middle'); label.setAttribute('class', 'edge-label'); label.textContent = link.subnet;
    group.append(visible, hit, label); edgeLayer.appendChild(group);
  }
}
function routerMirrorCandidates(routerId) {
  const networkByNode = new Map();
  for (const link of topology.links.filter(item => item.source === routerId || item.target === routerId)) {
    const group = groupLinkIds(link);
    const network = [...group].sort().join(',');
    for (const member of topology.links.filter(item => group.has(item.id))) {
      for (const id of [member.source, member.target]) {
        if (['client', 'server'].includes(nodeKind(id))) networkByNode.set(id, network);
      }
    }
  }
  return topology.nodes.filter(item => networkByNode.has(item.id)).map(item => ({node:item, network:networkByNode.get(item.id)}));
}
function mirrorControls(node) {
  if (node.type !== 'router') return '';
  const candidates = routerMirrorCandidates(node.id);
  const fields = [['source','通信节点 A'], ['target','通信节点 B'], ['destination','镜像接收节点']];
  const controls = !node.mirror ? '' : fields.map(([field, label]) => `<label class="form-field"><span>${label}</span><select data-mirror-field="${field}">${candidates.map(item => `<option value="${esc(item.node.id)}" ${node.mirror[field] === item.node.id ? 'selected' : ''}>${esc(item.node.name)} · ${esc(nodeIps(item.node)[0] || item.node.id)}</option>`).join('')}</select></label>`).join('');
  return `<div class="inspector-divider"></div><div class="endpoint-title">流量镜像 <small>复制两个节点之间双向经过本路由器的 IPv4 流量</small></div><label class="gui-option"><input type="checkbox" data-mirror-enable ${node.mirror ? 'checked' : ''}><span><strong>启用流量镜像</strong><small>将报文副本发送给指定接收节点</small></span></label>${controls}<div class="form-help">三个节点需与本路由器直接相连（可以经过交换机）；通信两端位于不同网段，且网段内没有其他路由器。接收端可用 tcpdump 查看副本。</div>`;
}
function renderInspector() {
  const body = $('#inspectorBody'); const button = $('#deleteBtn');
  button.disabled = !selection;
  if (!selection) { body.innerHTML = '<div class="inspector-empty"><div class="empty-glyph">◇</div><strong>选择一个元素</strong><p>点击画布上的节点或连线<br>在这里编辑详细配置</p></div>'; return; }
  if (selection.kind === 'node') {
    const node = nodeById(selection.id);
    if (!node) { selection = null; renderInspector(); return; }
    const connected = topology.links.filter(l => l.source === node.id || l.target === node.id);
    const guiControls = node.type === 'router' ? '<div class="form-help">自动使用随项目打包的 OpenWrt ARM64 rootfs。</div>' : node.type === 'switch' ? '<div class="form-help">虚拟二层交换机：同交换机网段的设备共享 Docker bridge，不需要配置 IP。</div>' : `<label class="gui-option"><input type="checkbox" data-node-field="gui" ${node.gui ? 'checked' : ''}><span><strong>需要 GUI 桌面</strong><small>Kasm Ubuntu 桌面，预装常用网络工具</small></span></label>${node.gui ? `<div class="gui-credentials"><div class="credential-title">GUI 登录信息</div><div class="credential-row"><span>地址</span><code>https://localhost:${guiPort(node.id)}</code></div><div class="credential-row"><span>用户名</span><code>${GUI_USERNAME}</code></div><div class="credential-row"><span>密码</span><code>${esc(topology.guiPassword)}</code></div><button type="button" data-copy-gui>复制登录信息</button><small>内置 ping、ip、curl、wget、SSH、Telnet、FTP、Netcat、traceroute、tcpdump、nmap 等工具。执行 <code>sudo -i</code> 可免密进入 root。</small></div>` : ''}`;
    const serverIp = nodeIps(node)[0] || '<服务器IP>';
    const serverControls = node.type === 'server' ? `<div class="gui-credentials"><div class="credential-title">服务器登录信息</div><div class="credential-row"><span>用户名</span><code>${SERVER_USERNAME}</code></div><div class="credential-row"><span>密码</span><code>${esc(topology.serverPassword)}</code></div><div class="credential-row"><span>SSH</span><code>ssh ${SERVER_USERNAME}@${esc(serverIp)}</code></div><div class="credential-row"><span>Telnet</span><code>telnet ${esc(serverIp)} 23</code></div><div class="credential-row"><span>FTP</span><code>ftp ${esc(serverIp)}</code></div><div class="credential-row"><span>HTTP</span><code>http://${esc(serverIp)}/</code></div><button type="button" data-copy-server>复制服务器信息</button><small>SSH 使用 22 端口，Telnet 使用 23 端口，FTP 使用 21 端口和被动端口 30000–30009，Apache 使用 80 端口。密码会写入生成项目的 .env。</small></div>` : '';
    body.innerHTML = `<div class="inspector-body"><div class="inspector-kicker">NODE / ${esc(node.id)}</div><div class="inspector-heading">${esc(node.name)}</div><label class="form-field"><span>节点名称</span><input data-node-field="name" maxlength="60" value="${esc(node.name)}"></label><label class="form-field"><span>节点类型</span><select data-node-field="type">${Object.keys(TYPE_LABEL).map(type => `<option value="${type}" ${node.type === type ? 'selected' : ''}>${TYPE_LABEL[type]}</option>`).join('')}</select></label>${guiControls}${serverControls}${mirrorControls(node)}<div class="form-help">客户端、服务器可连接一条线；路由器、交换机可连接多个设备。</div><div class="inspector-divider"></div><div class="endpoint-title">连接接口 <small>${connected.length} 个网络接口</small></div>${connected.map(l => `<div class="form-help" style="margin:0 0 9px">${esc(l.subnet)} · ${esc(node.type === 'switch' ? '二层交换端口' : (l.source === node.id ? l.sourceIp : l.targetIp))}</div>`).join('') || '<div class="form-help">尚无连接。点击节点右侧圆点开始连接。</div>'}</div>`;
    body.querySelector('[data-node-field="name"]').addEventListener('input', event => { node.name = event.target.value; save(); renderNodes(); });
    body.querySelector('[data-node-field="type"]').addEventListener('change', event => { if (!['router','switch'].includes(event.target.value) && degree(node.id) > 1) { toast('多连接节点必须保持为路由器或交换机'); event.target.value = node.type; return; } node.type = event.target.value; if (['router','switch'].includes(node.type)) node.gui = false; if (node.type !== 'router') delete node.mirror; for (const item of topology.nodes) if (item.mirror && Object.values(item.mirror).includes(node.id) && !['client','server'].includes(node.type)) delete item.mirror; save(); render(); });
    body.querySelector('[data-mirror-enable]')?.addEventListener('change', event => {
      if (!event.target.checked) { delete node.mirror; save(); renderInspector(); return; }
      const candidates = routerMirrorCandidates(node.id);
      const source = candidates[0];
      const target = candidates.find(item => item.network !== source?.network);
      const destination = candidates.find(item => item.node.id !== source?.node.id && item.node.id !== target?.node.id);
      if (!source || !target || !destination) { event.target.checked = false; toast('请先连接至少三个节点，其中通信两端位于不同网段'); return; }
      node.mirror = {source:source.node.id, target:target.node.id, destination:destination.node.id}; save(); renderInspector();
    });
    body.querySelectorAll('[data-mirror-field]').forEach(select => select.addEventListener('change', event => {
      const field = event.target.dataset.mirrorField;
      const updated = {...node.mirror, [field]:event.target.value};
      const previousField = Object.keys(updated).find(other => other !== field && updated[other] === event.target.value);
      if (previousField) updated[previousField] = node.mirror[field];
      const candidates = routerMirrorCandidates(node.id);
      const networks = Object.fromEntries(candidates.map(item => [item.node.id, item.network]));
      if (new Set(Object.values(updated)).size !== 3 || networks[updated.source] === networks[updated.target]) { toast('请选择三个不同节点，通信两端要位于不同网段'); renderInspector(); return; }
      node.mirror = updated; save(); renderInspector();
    }));
    body.querySelector('[data-node-field="gui"]')?.addEventListener('change', event => { node.gui = event.target.checked; save(); render(); if (node.gui) toast('GUI 登录信息和 root 使用方式已显示在属性面板'); });
    body.querySelector('[data-copy-gui]')?.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(`地址：https://localhost:${guiPort(node.id)}\n用户名：${GUI_USERNAME}\n密码：${topology.guiPassword}\n容器内 root：在桌面终端执行 sudo -i（无需密码）`); toast('GUI 登录信息已复制'); }
      catch (error) { toast(`复制失败：${error.message}`); }
    });
    body.querySelector('[data-copy-server]')?.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(`用户名：${SERVER_USERNAME}\n密码：${topology.serverPassword}\nSSH：ssh ${SERVER_USERNAME}@${serverIp}\nTelnet：telnet ${serverIp} 23\nFTP：ftp ${serverIp}\nHTTP：http://${serverIp}/`); toast('服务器登录信息已复制'); }
      catch (error) { toast(`复制失败：${error.message}`); }
    });
    return;
  }
  const link = topology.links.find(l => l.id === selection.id);
  if (!link) { selection = null; renderInspector(); return; }
  const a = nodeById(link.source), b = nodeById(link.target);
  const group = groupLinkIds(link);
  const isShared = group.size > 1;
  body.innerHTML = `<div class="inspector-body"><div class="inspector-kicker">LINK / ${esc(link.id)}</div><div class="inspector-heading">${esc(a.name)} ↔ ${esc(b.name)}</div><label class="form-field"><span>网络网段 CIDR</span><input data-link-field="subnet" value="${esc(link.subnet)}" spellcheck="false"></label><div class="form-help">${isShared ? '交换机连接共享一个 Docker bridge 网段。修改网段会同步调整同网段接口。' : '直连链路对应独立的 Docker bridge 网络。'}</div><div class="inspector-divider"></div>${['source','target'].map((side, i) => {
    const node = i ? b : a;
    return `<div class="endpoint-title">${esc(node.name)} <small>${i ? '目标接口' : '源接口'}</small></div>${node.type === 'switch' ? '<div class="form-help">二层交换机端口（无 IP/MAC）</div>' : `<label class="form-field"><span>IPv4 地址</span><input data-link-field="${side}Ip" value="${esc(link[side + 'Ip'])}" spellcheck="false"></label><label class="form-field"><span>MAC 地址</span><input data-link-field="${side}Mac" value="${esc(link[side + 'Mac'])}" spellcheck="false"></label>`}${i ? '' : '<div class="inspector-divider"></div>'}`;
  }).join('')}</div>`;
  body.querySelectorAll('[data-link-field]').forEach(input => input.addEventListener('change', event => {
    const field = event.target.dataset.linkField;
    try { if (field === 'subnet') readdress(groupLinkIds(link), event.target.value.trim()); else link[field] = event.target.value.trim(); save(); render(); }
    catch (error) { toast(error.message); renderInspector(); }
  }));
}
function render() { renderNodes(); renderEdges(); renderInspector(); $('#counts').textContent = `${topology.nodes.length} 个节点 · ${topology.links.length} 条连线`; renderTransform(); }
function deleteSelected() {
  if (!selection) return;
  if (selection.kind === 'node') { topology.nodes = topology.nodes.filter(n => n.id !== selection.id); topology.links = topology.links.filter(l => l.source !== selection.id && l.target !== selection.id); for (const node of topology.nodes) if (node.mirror && Object.values(node.mirror).includes(selection.id)) delete node.mirror; }
  else topology.links = topology.links.filter(l => l.id !== selection.id);
  selection = null; stopConnecting(); save(); render(); toast('已删除');
}
function zoom(factor) { const rect = viewport.getBoundingClientRect(), cx = rect.width / 2, cy = rect.height / 2; const next = Math.max(.45, Math.min(1.7, transform.scale * factor)); transform.x = cx - (cx - transform.x) * next / transform.scale; transform.y = cy - (cy - transform.y) * next / transform.scale; transform.scale = next; renderTransform(); }
function fitView() {
  if (!topology.nodes.length) { transform = {x:65,y:80,scale:1}; renderTransform(); return; }
  const rect = viewport.getBoundingClientRect(); const xs = topology.nodes.map(n => Number(n.x)), ys = topology.nodes.map(n => Number(n.y));
  const minX = Math.min(...xs), minY = Math.min(...ys), maxX = Math.max(...xs) + NODE_W, maxY = Math.max(...ys) + NODE_H;
  const scale = Math.max(.45, Math.min(1.25, Math.min((rect.width - 100) / Math.max(200, maxX - minX), (rect.height - 100) / Math.max(140, maxY - minY))));
  transform = { scale, x: (rect.width - (maxX + minX) * scale) / 2, y: (rect.height - (maxY + minY) * scale) / 2 }; renderTransform();
}
async function postJson(path, payload) {
  const response = await fetch(path, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload) });
  if (!response.ok) { let details = {}; try { details = await response.json(); } catch (_) {} const error = new Error(details.error || `请求失败 (${response.status})`); error.status = response.status; error.replaceProjects = details.replaceProjects; throw error; }
  return response;
}
function request(path) { return postJson(path, topology); }
function showFile(name) {
  if (!generated) return;
  activeFile = name; $('#fileTitle').textContent = name;
  const asset = generated.assets?.find(item => item.path === name);
  $('#codeContent').textContent = asset ? `OpenWrt ARM64 rootfs · 二进制文件 · ${(asset.size / 1024 / 1024).toFixed(1)} MiB\n下载 ZIP 时会自动打包。` : generated.files[name];
  $('#copyBtn').disabled = !!asset;
  document.querySelectorAll('.file-item').forEach(el => el.classList.toggle('active', el.dataset.file === name));
}
function showGenerated(result) {
  generated = result;
  const list = $('#fileList'); list.replaceChildren();
  Object.keys(result.files).sort((a,b) => a === 'compose.yaml' ? -1 : b === 'compose.yaml' ? 1 : a.localeCompare(b)).forEach(name => {
    const button = document.createElement('button'); button.className = 'file-item'; button.dataset.file = name; button.textContent = `▤  ${name}`; button.addEventListener('click', () => showFile(name)); list.appendChild(button);
  });
  (result.assets || []).forEach(asset => { const button = document.createElement('button'); button.className = 'file-item'; button.dataset.file = asset.path; button.textContent = `▣  ${asset.path}`; button.addEventListener('click', () => showFile(asset.path)); list.appendChild(button); });
  $('#warnings').textContent = result.warnings.length ? `⚠ ${result.warnings.join('；')}` : '';
  showFile(result.files[activeFile] || result.assets?.some(asset => asset.path === activeFile) ? activeFile : 'compose.yaml');
}
async function preview() {
  try {
    showGenerated(await (await request('/api/preview')).json()); toast('配置已生成');
  } catch (error) { toast(error.message); }
}
async function download() {
  try {
    triggerDownload(await (await request('/api/download')).blob(), 'topology-lab.zip'); toast('Docker 项目已下载');
  } catch (error) { toast(error.message); }
}

function safePathParts(path) {
  if (typeof path !== 'string' || !path || path.length > 500 || path.startsWith('/') || path.includes('\\') || path.includes('\0')) throw new Error(`不安全的文件路径：${path}`);
  const parts = path.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) throw new Error(`不安全的文件路径：${path}`);
  return parts;
}
async function parentDirectory(root, path, create) {
  const parts = safePathParts(path); const filename = parts.pop(); let directory = root;
  for (const part of parts) directory = await directory.getDirectoryHandle(part, {create});
  return {directory, filename};
}
async function existingFile(root, path) {
  try {
    const {directory, filename} = await parentDirectory(root, path, false);
    await directory.getFileHandle(filename, {create:false}); return true;
  } catch (error) {
    if (error.name === 'NotFoundError') return false;
    throw error;
  }
}
async function writeDirectoryFile(root, path, contents) {
  const {directory, filename} = await parentDirectory(root, path, true);
  const handle = await directory.getFileHandle(filename, {create:true});
  const writable = await handle.createWritable();
  try { await writable.write(contents); await writable.close(); }
  catch (error) { try { await writable.abort(); } catch (_) {} throw error; }
}
function localStatus(message, error = false) {
  const element = $('#localStatus'); element.textContent = message; element.title = message; element.classList.toggle('error', error);
}
function directoryStore(operation, value) {
  if (!('indexedDB' in window)) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open('topology-local-output', 1);
    opening.onupgradeneeded = () => opening.result.createObjectStore('settings');
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const database = opening.result;
      const transaction = database.transaction('settings', operation === 'get' ? 'readonly' : 'readwrite');
      const store = transaction.objectStore('settings');
      const request = operation === 'get' ? store.get('directory') : operation === 'set' ? store.put(value, 'directory') : store.delete('directory');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      transaction.oncomplete = () => database.close();
    };
  });
}
function setLinkedDirectory(directory) {
  linkedDirectory = directory;
  $('#saveLocalBtn').textContent = directory ? '▣ 更换文件夹' : '▣ 选择文件夹并自动保存';
  $('#disconnectLocalBtn').hidden = !directory;
  $('#autoComposeInput').disabled = !directory || directory.mode !== 'native';
  if (!directory || directory.mode !== 'native') $('#autoComposeInput').checked = false;
  if (directory?.mode === 'native') sessionStorage.setItem('topology-local-directory', JSON.stringify({token:directory.token, name:directory.name}));
  else sessionStorage.removeItem('topology-local-directory');
  if (!directory || directory.mode === 'native') directoryStore('delete').catch(() => {});
  localStatus(directory ? `已关联「${directory.name}」· 修改后自动写入${directory.mode === 'browser' ? ' · 自动启动需本机运行编辑器' : ''}` : '尚未关联本地文件夹');
}
function scheduleLocalSync(delay = 900) {
  if (!linkedDirectory) return;
  syncPending = true;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(performLocalSync, delay);
}
async function browserSync(directory, snapshot) {
  const result = await (await postJson('/api/preview', snapshot)).json();
  const changed = [];
  for (const [path, contents] of Object.entries(result.files)) {
    let same = false;
    if (await existingFile(directory, path)) {
      const {directory:parent, filename} = await parentDirectory(directory, path, false);
      same = await (await (await parent.getFileHandle(filename)).getFile()).text() === contents;
    }
    if (!same) { await writeDirectoryFile(directory, path, contents); changed.push(path); }
  }
  for (const asset of result.assets || []) {
    let same = false;
    if (await existingFile(directory, asset.path)) {
      const {directory:parent, filename} = await parentDirectory(directory, asset.path, false);
      same = (await (await parent.getFileHandle(filename)).getFile()).size === asset.size;
    }
    if (!same) {
      const response = await fetch(asset.downloadUrl, {cache:'no-store'});
      if (!response.ok) throw new Error(`无法读取 ${asset.path} (${response.status})`);
      await writeDirectoryFile(directory, asset.path, await response.blob()); changed.push(asset.path);
    }
  }
  return {changed, ran:false};
}
async function performLocalSync() {
  if (!linkedDirectory || !syncPending) return;
  if (syncInFlight) return;
  syncPending = false; syncInFlight = true;
  const directory = linkedDirectory, currentRevision = revision;
  const snapshot = JSON.parse(JSON.stringify(topology));
  const autoRun = directory.mode === 'native' && $('#autoComposeInput').checked;
  localStatus(autoRun ? `正在写入「${directory.name}」并构建启动…` : `正在同步「${directory.name}」…`);
  try {
    let result;
    if (directory.mode === 'native') {
      const payload = {token:directory.token, topology:snapshot, autoRun};
      try { result = await (await postJson('/api/local/sync', payload)).json(); }
      catch (error) {
        if (!Array.isArray(error.replaceProjects) || !error.replaceProjects.length) throw error;
        if (!confirm(`同一文件夹中仍有旧项目正在运行：${error.replaceProjects.join('、')}。\n\n要启动当前项目，需要停止并删除这些旧容器；容器内未持久化的修改会丢失。确认替换？`)) throw new Error('已保留旧项目；生成文件已更新，当前项目未启动');
        result = await (await postJson('/api/local/sync', {...payload, replaceProjects:error.replaceProjects})).json();
      }
    } else result = await browserSync(directory.handle, snapshot);
    if (linkedDirectory !== directory) return;
    localStatus(`已同步「${directory.name}」${result.ran ? ' · Compose 已构建并启动' : result.changed.length ? ` · 更新 ${result.changed.length} 个文件` : ' · 文件已是最新'}`);
    if (currentRevision === revision) {
      const fresh = await (await postJson('/api/preview', snapshot)).json();
      if (currentRevision === revision && linkedDirectory === directory) showGenerated(fresh);
    }
  } catch (error) {
    if (linkedDirectory === directory) {
      localStatus(`同步失败：${error.message}`, true); toast(error.message);
      if (error.message.includes('关联已失效')) setLinkedDirectory(null);
    }
  } finally {
    syncInFlight = false;
    if (syncPending) scheduleLocalSync(150);
  }
}
async function saveLocal() {
  const button = $('#saveLocalBtn');
  button.disabled = true;
  try {
    let directory;
    if (nativePickerAvailable) {
      const selected = await (await request('/api/local/select')).json();
      directory = {mode:'native', token:selected.token, name:selected.name};
      if (selected.collisions.length && !confirm(`所选文件夹中已有以下生成文件：\n\n${selected.collisions.slice(0,12).join('\n')}${selected.collisions.length > 12 ? '\n…' : ''}\n\n关联后，拓扑修改会自动覆盖这些生成文件。确认继续？其他文件不会删除。`)) return;
    } else {
      if (typeof window.showDirectoryPicker !== 'function') throw new Error('此环境无法使用文件夹选择器，请下载 ZIP');
      const handle = await window.showDirectoryPicker({id:'topology-project-output', mode:'readwrite', startIn:'documents'});
      const result = await (await request('/api/preview')).json();
      const paths = [...Object.keys(result.files), ...(result.assets || []).map(asset => asset.path)];
      const collisions = [];
      for (const path of paths) if (await existingFile(handle, path)) collisions.push(path);
      if (collisions.length && !confirm(`所选文件夹中已有以下生成文件：\n\n${collisions.slice(0,12).join('\n')}${collisions.length > 12 ? '\n…' : ''}\n\n关联后，拓扑修改会自动覆盖这些生成文件。确认继续？其他文件不会删除。`)) return;
      directory = {mode:'browser', handle, name:handle.name};
    }
    setLinkedDirectory(directory);
    if (directory.mode === 'browser') directoryStore('set', directory.handle).catch(() => {});
    scheduleLocalSync(0);
  } catch (error) {
    if (error.name === 'AbortError' || error.message === '已取消选择文件夹') return;
    if (nativePickerAvailable && (error.status === 501 || error.message.startsWith('无法选择文件夹'))) {
      nativePickerAvailable = false; toast('本机选择器不可用，请再次点击以使用浏览器文件夹选择器');
    } else toast(error.message);
  }
  finally { button.disabled = false; }
}

document.querySelectorAll('[data-add]').forEach(button => {
  button.addEventListener('click', () => { const rect = viewport.getBoundingClientRect(); const p = worldPoint(rect.left + rect.width / 2, rect.top + rect.height / 2); addNode(button.dataset.add, p.x - NODE_W / 2 + (topology.nodes.length % 3) * 28, p.y - NODE_H / 2 + (topology.nodes.length % 3) * 25); });
  button.addEventListener('dragstart', event => event.dataTransfer.setData('text/plain', button.dataset.add));
});
viewport.addEventListener('dragover', event => event.preventDefault());
viewport.addEventListener('drop', event => { event.preventDefault(); const type = event.dataTransfer.getData('text/plain'); if (!TYPE_LABEL[type]) return; const p = worldPoint(event.clientX, event.clientY); addNode(type, p.x - NODE_W / 2, p.y - NODE_H / 2); });
viewport.addEventListener('pointerdown', event => { if (event.button !== 0 || event.target.closest?.('.topology-node') || event.target.classList?.contains('edge-hit')) return; if (pendingSource) { stopConnecting(); return; } selection = null; render(); dragging = {kind:'pan', x:event.clientX - transform.x, y:event.clientY - transform.y}; viewport.setPointerCapture(event.pointerId); viewport.classList.add('panning'); });
viewport.addEventListener('pointermove', event => { if (!dragging) return; if (dragging.kind === 'pan') { transform.x = event.clientX - dragging.x; transform.y = event.clientY - dragging.y; renderTransform(); } else { const node = nodeById(dragging.id); if (!node) return; const p = worldPoint(event.clientX,event.clientY); node.x = Math.round(Math.max(0, Math.min(2240, p.x - dragging.dx))); node.y = Math.round(Math.max(0, Math.min(1520, p.y - dragging.dy))); const el = [...nodeLayer.children].find(item => item.dataset.nodeId === node.id); if (el) { el.style.left = `${node.x}px`; el.style.top = `${node.y}px`; } renderEdges(); } });
viewport.addEventListener('pointerup', () => { if (dragging?.kind === 'node') { save(); renderNodes(); } dragging = null; viewport.classList.remove('panning'); });
viewport.addEventListener('wheel', event => { if (!event.ctrlKey && !event.metaKey) return; event.preventDefault(); zoom(event.deltaY < 0 ? 1.08 : .92); }, {passive:false});
$('#connectBtn').addEventListener('click', () => { if (connectMode) stopConnecting(); else { connectMode = true; $('#connectBtn').classList.add('active'); viewport.classList.add('connecting'); $('#canvasHint').textContent = '点击第一个节点，再点击目标节点 · Esc 取消'; } });
$('#zoomIn').addEventListener('click', () => zoom(1.2)); $('#zoomOut').addEventListener('click', () => zoom(1/1.2)); $('#fitBtn').addEventListener('click', fitView);
$('#deleteBtn').addEventListener('click', deleteSelected); $('#previewBtn').addEventListener('click', preview); $('#downloadBtn').addEventListener('click', download); $('#saveLocalBtn').addEventListener('click', saveLocal);
$('#projectNameInput').value = topology.projectName;
$('#projectNameInput').addEventListener('change', event => {
  const value = event.target.value.trim();
  if (!PROJECT_NAME_PATTERN.test(value)) { event.target.value = topology.projectName; toast('项目名须以小写字母或数字开头，只能包含小写字母、数字、-、_，最多 63 位'); return; }
  if (value !== topology.projectName) { topology.projectName = value; save(); }
});
$('#autoComposeInput').addEventListener('change', () => scheduleLocalSync(0));
$('#disconnectLocalBtn').addEventListener('click', () => { clearTimeout(syncTimer); syncPending = false; setLinkedDirectory(null); toast('已停止自动同步'); });
try {
  const restored = JSON.parse(sessionStorage.getItem('topology-local-directory'));
  if (restored && typeof restored.token === 'string' && typeof restored.name === 'string') setLinkedDirectory({mode:'native', token:restored.token, name:restored.name});
} catch (_) {}
fetch('/api/local/capabilities').then(response => response.json()).then(capabilities => { nativePickerAvailable = !!capabilities.nativePicker; }).catch(() => {}).finally(() => { $('#saveLocalBtn').disabled = false; });
directoryStore('get').then(async handle => {
  if (!linkedDirectory && handle && await handle.queryPermission({mode:'readwrite'}) === 'granted')
    setLinkedDirectory({mode:'browser', handle, name:handle.name});
}).catch(() => {});
$('#saveTopologyBtn').addEventListener('click', saveTopologyFile); $('#openTopologyBtn').addEventListener('click', openTopologyFile);
$('#copyBtn').addEventListener('click', async () => { if (!generated || !activeFile) return; await navigator.clipboard.writeText(generated.files[activeFile]); toast('已复制文件内容'); });
$('#sampleBtn').addEventListener('click', () => { topology = demoTopology(); selection = null; stopConnecting(); save(); render(); fitView(); toast('已加载示例拓扑'); });
$('#clearBtn').addEventListener('click', () => { if (!confirm('清空当前拓扑？此操作会删除所有节点和连线。')) return; topology = {nodes:[],links:[]}; selection = null; stopConnecting(); save(); render(); $('#fileList').innerHTML = '<div class="empty-file">尚未生成文件</div>'; $('#codeContent').textContent = '添加节点与连线后，点击“刷新预览”。'; $('#warnings').textContent = ''; toast('画布已清空'); });
document.addEventListener('keydown', event => { if (event.key === 'Escape') stopConnecting(); if ((event.key === 'Delete' || event.key === 'Backspace') && !['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)) deleteSelected(); });
render(); requestAnimationFrame(fitView);
