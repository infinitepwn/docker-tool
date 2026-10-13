const $ = (selector) => document.querySelector(selector);
const viewport = $('#viewport');
const world = $('#world');
const nodeLayer = $('#nodes');
const edgeLayer = $('#edges');
const STORAGE_KEY = 'topology-lab-v1';
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
async function preview() {
  try {
    const result = await (await request('/api/preview')).json(); generated = result;
    const list = $('#fileList'); list.replaceChildren();
    Object.keys(result.files).sort((a,b) => a === 'compose.yaml' ? -1 : b === 'compose.yaml' ? 1 : a.localeCompare(b)).forEach(name => {
      const button = document.createElement('button'); button.className = 'file-item'; button.dataset.file = name; button.textContent = `▤  ${name}`; button.addEventListener('click', () => showFile(name)); list.appendChild(button);
    });
    (result.assets || []).forEach(asset => { const button = document.createElement('button'); button.className = 'file-item'; button.dataset.file = asset.path; button.textContent = `▣  ${asset.path}`; button.addEventListener('click', () => showFile(asset.path)); list.appendChild(button); });
    $('#warnings').textContent = result.warnings.length ? `⚠ ${result.warnings.join('；')}` : '';
    showFile(result.files[activeFile] || result.assets?.some(asset => asset.path === activeFile) ? activeFile : 'compose.yaml'); toast('配置已生成');
  } catch (error) { toast(error.message); }
}
async function download() {
  try {
    const blob = await (await request('/api/download')).blob(); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'topology-lab.zip'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000); toast('Docker 项目已下载');
  } catch (error) { toast(error.message); }
}

async function saveLocal() {
  const button = $('#saveLocalBtn');
  const previous = localStorage.getItem('topology-output-directory') || '~/Documents/Cybersecurity-lab/lab3';
  const directory = prompt('选择生成目录（输入本机绝对路径，支持 ~/ 开头）：\n例如 ~/Documents/Cybersecurity-lab/lab3\n\n目录不存在时会自动创建。', previous);
  if (directory === null) return;
  if (!directory.trim()) { toast('请输入生成目录'); return; }
  button.disabled = true;
  try {
    const send = async (confirmOverwrite) => {
      const response = await fetch('/api/save', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({...topology,outputDirectory:directory.trim(),confirmOverwrite})});
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `保存失败 (${response.status})`);
      return result;
    };
    let result = await send(false);
    if (result.needsConfirmation) {
      const names = result.overwritten.slice(0, 12).join('\n');
      if (!confirm(`将覆盖以下已有文件（其他文件不会删除）：\n${result.directory}\n\n${names}${result.overwritten.length > 12 ? '\n…' : ''}\n\n确认继续？`)) return;
      result = await send(true);
    }
    localStorage.setItem('topology-output-directory', directory.trim());
    toast(`已写入 ${result.written.length} 个文件：${result.directory}`);
    alert(`已生成到本地：\n${result.directory}\n\n进入该目录运行：docker compose up -d --build --force-recreate`);
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
$('#copyBtn').addEventListener('click', async () => { if (!generated || !activeFile) return; await navigator.clipboard.writeText(generated.files[activeFile]); toast('已复制文件内容'); });
$('#sampleBtn').addEventListener('click', () => { topology = demoTopology(); selection = null; stopConnecting(); save(); render(); fitView(); toast('已加载示例拓扑'); });
$('#clearBtn').addEventListener('click', () => { if (!confirm('清空当前拓扑？此操作会删除所有节点和连线。')) return; topology = {nodes:[],links:[]}; selection = null; stopConnecting(); save(); render(); $('#fileList').innerHTML = '<div class="empty-file">尚未生成文件</div>'; $('#codeContent').textContent = '添加节点与连线后，点击“刷新预览”。'; $('#warnings').textContent = ''; toast('画布已清空'); });
document.addEventListener('keydown', event => { if (event.key === 'Escape') stopConnecting(); if ((event.key === 'Delete' || event.key === 'Backspace') && !['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)) deleteSelected(); });
render(); requestAnimationFrame(fitView);
