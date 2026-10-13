const $ = (selector) => document.querySelector(selector);
const viewport = $('#viewport');
const world = $('#world');
const nodeLayer = $('#nodes');
const edgeLayer = $('#edges');
const STORAGE_KEY = 'topology-lab-v1';
const TOPOLOGY_FORMAT = 'topology-lab';
const TOPOLOGY_VERSION = 1;
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
    if (saved && Array.isArray(saved.nodes) && Array.isArray(saved.links)) return saved;
  } catch (_) {}
  return demoTopology();
}
function save() { localStorage.setItem(STORAGE_KEY, JSON.stringify(topology)); generated = null; $('#fileTitle').textContent = activeFile ? `${activeFile} · 需刷新` : '选择文件查看内容'; }
function topologyDocument() {
  return {format: TOPOLOGY_FORMAT, version: TOPOLOGY_VERSION, savedAt: new Date().toISOString(), viewport: {...transform}, nodes: topology.nodes, links: topology.links};
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
  if (document.nodes.length > 80 || document.links.length > 160) throw new Error('拓扑规模超过限制');
  const ids = new Set();
  const nodes = document.nodes.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id.trim() || raw.id.length > 80 || ids.has(raw.id) || !TYPE_LABEL[raw.type]) throw new Error(`第 ${index + 1} 个节点无效`);
    if (raw.name !== undefined && (typeof raw.name !== 'string' || raw.name.length > 200)) throw new Error(`第 ${index + 1} 个节点名称无效`);
    ids.add(raw.id);
    const x = Number.isFinite(Number(raw.x)) ? Number(raw.x) : 120 + index * 35;
    const y = Number.isFinite(Number(raw.y)) ? Number(raw.y) : 160 + index * 25;
    return {id:raw.id, name:typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : raw.id, type:raw.type, gui:(raw.type === 'client' || raw.type === 'server') && raw.gui === true, x:Math.max(0, Math.min(2240, x)), y:Math.max(0, Math.min(1520, y))};
  });
  const linkIds = new Set();
  const links = document.links.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id.trim() || raw.id.length > 80 || linkIds.has(raw.id) || !ids.has(raw.source) || !ids.has(raw.target) || raw.source === raw.target) throw new Error(`第 ${index + 1} 条连线无效`);
    const fields = ['subnet','sourceIp','targetIp','sourceMac','targetMac'];
    if (fields.some(field => raw[field] !== undefined && (typeof raw[field] !== 'string' || raw[field].length > 200))) throw new Error(`第 ${index + 1} 条连线配置无效`);
    linkIds.add(raw.id);
    return {id:raw.id, source:raw.source, target:raw.target, subnet:raw.subnet || '', sourceIp:raw.sourceIp || '', targetIp:raw.targetIp || '', sourceMac:raw.sourceMac || '', targetMac:raw.targetMac || ''};
  });
  const view = document.viewport;
  const viewportState = view && [view.x, view.y, view.scale].every(value => Number.isFinite(Number(value))) ? {x:Number(view.x), y:Number(view.y), scale:Math.max(.45, Math.min(1.7, Number(view.scale)))} : null;
  return {nodes, links, viewportState};
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
    topology = {nodes:parsed.nodes, links:parsed.links}; selection = null; stopConnecting(); save(); render();
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
function renderInspector() {
  const body = $('#inspectorBody'); const button = $('#deleteBtn');
  button.disabled = !selection;
  if (!selection) { body.innerHTML = '<div class="inspector-empty"><div class="empty-glyph">◇</div><strong>选择一个元素</strong><p>点击画布上的节点或连线<br>在这里编辑详细配置</p></div>'; return; }
  if (selection.kind === 'node') {
    const node = nodeById(selection.id);
    if (!node) { selection = null; renderInspector(); return; }
    const connected = topology.links.filter(l => l.source === node.id || l.target === node.id);
    body.innerHTML = `<div class="inspector-body"><div class="inspector-kicker">NODE / ${esc(node.id)}</div><div class="inspector-heading">${esc(node.name)}</div><label class="form-field"><span>节点名称</span><input data-node-field="name" maxlength="60" value="${esc(node.name)}"></label><label class="form-field"><span>节点类型</span><select data-node-field="type">${Object.keys(TYPE_LABEL).map(type => `<option value="${type}" ${node.type === type ? 'selected' : ''}>${TYPE_LABEL[type]}</option>`).join('')}</select></label>${node.type === 'router' ? '<div class="form-help">自动使用随项目打包的 OpenWrt ARM64 rootfs。</div>' : node.type === 'switch' ? '<div class="form-help">虚拟二层交换机：同交换机网段的设备共享 Docker bridge，不需要配置 IP。</div>' : `<label class="gui-option"><input type="checkbox" data-node-field="gui" ${node.gui ? 'checked' : ''}><span><strong>需要 GUI 桌面</strong><small>使用 kasmweb/ubuntu-focal-desktop:1.16.0</small></span></label>`}<div class="form-help">客户端、服务器可连接一条线；路由器、交换机可连接多个设备。</div><div class="inspector-divider"></div><div class="endpoint-title">连接接口 <small>${connected.length} 个网络接口</small></div>${connected.map(l => `<div class="form-help" style="margin:0 0 9px">${esc(l.subnet)} · ${esc(node.type === 'switch' ? '二层交换端口' : (l.source === node.id ? l.sourceIp : l.targetIp))}</div>`).join('') || '<div class="form-help">尚无连接。点击节点右侧圆点开始连接。</div>'}</div>`;
    body.querySelector('[data-node-field="name"]').addEventListener('input', event => { node.name = event.target.value; save(); renderNodes(); });
    body.querySelector('[data-node-field="type"]').addEventListener('change', event => { if (!['router','switch'].includes(event.target.value) && degree(node.id) > 1) { toast('多连接节点必须保持为路由器或交换机'); event.target.value = node.type; return; } node.type = event.target.value; if (['router','switch'].includes(node.type)) node.gui = false; save(); render(); });
    body.querySelector('[data-node-field="gui"]')?.addEventListener('change', event => { node.gui = event.target.checked; save(); renderNodes(); });
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
  if (selection.kind === 'node') { topology.nodes = topology.nodes.filter(n => n.id !== selection.id); topology.links = topology.links.filter(l => l.source !== selection.id && l.target !== selection.id); }
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
async function request(path) {
  const response = await fetch(path, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(topology) });
  if (!response.ok) { let message = `请求失败 (${response.status})`; try { message = (await response.json()).error || message; } catch (_) {} throw new Error(message); }
  return response;
}
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
async function saveLocal() {
  const button = $('#saveLocalBtn');
  if (typeof window.showDirectoryPicker !== 'function') { toast('当前浏览器不支持文件夹选择，改为下载 ZIP'); await download(); return; }
  let directory;
  try { directory = await window.showDirectoryPicker({id:'topology-project-output', mode:'readwrite', startIn:'documents'}); }
  catch (error) { if (error.name !== 'AbortError') toast(`选择文件夹失败：${error.message}`); return; }
  button.disabled = true;
  try {
    const result = generated || await (await request('/api/preview')).json();
    if (!generated) showGenerated(result);
    const entries = Object.entries(result.files).map(([path, contents]) => ({path, contents}));
    for (const asset of result.assets || []) {
      if (typeof asset.downloadUrl !== 'string' || !asset.downloadUrl.startsWith('/api/assets/')) throw new Error(`资产地址无效：${asset.path}`);
      const response = await fetch(asset.downloadUrl, {cache:'no-store'});
      if (!response.ok) throw new Error(`无法读取 ${asset.path} (${response.status})`);
      entries.push({path:asset.path, contents:await response.blob()});
    }
    const overwritten = [];
    for (const entry of entries) if (await existingFile(directory, entry.path)) overwritten.push(entry.path);
    if (overwritten.length) {
      const names = overwritten.slice(0, 12).join('\n');
      if (!confirm(`所选文件夹中已有以下文件：\n\n${names}${overwritten.length > 12 ? '\n…' : ''}\n\n确认覆盖？其他文件不会删除。`)) return;
    }
    let written = 0;
    for (const entry of entries) {
      try { await writeDirectoryFile(directory, entry.path, entry.contents); written++; }
      catch (error) { throw new Error(`写入中断（已完成 ${written}/${entries.length}）：${entry.path}：${error.message}`); }
    }
    toast(`已向“${directory.name}”写入 ${entries.length} 个文件`);
    alert(`项目已生成到文件夹“${directory.name}”。\n\n在该目录运行：docker compose up -d --build --force-recreate`);
  } catch (error) { toast(error.message); }
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
$('#saveTopologyBtn').addEventListener('click', saveTopologyFile); $('#openTopologyBtn').addEventListener('click', openTopologyFile);
$('#copyBtn').addEventListener('click', async () => { if (!generated || !activeFile) return; await navigator.clipboard.writeText(generated.files[activeFile]); toast('已复制文件内容'); });
$('#sampleBtn').addEventListener('click', () => { topology = demoTopology(); selection = null; stopConnecting(); save(); render(); fitView(); toast('已加载示例拓扑'); });
$('#clearBtn').addEventListener('click', () => { if (!confirm('清空当前拓扑？此操作会删除所有节点和连线。')) return; topology = {nodes:[],links:[]}; selection = null; stopConnecting(); save(); render(); $('#fileList').innerHTML = '<div class="empty-file">尚未生成文件</div>'; $('#codeContent').textContent = '添加节点与连线后，点击“刷新预览”。'; $('#warnings').textContent = ''; toast('画布已清空'); });
document.addEventListener('keydown', event => { if (event.key === 'Escape') stopConnecting(); if ((event.key === 'Delete' || event.key === 'Backspace') && !['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)) deleteSelected(); });
render(); requestAnimationFrame(fitView);
