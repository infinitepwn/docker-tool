const $ = (selector) => document.querySelector(selector);
const viewport = $('#viewport');
const world = $('#world');
const nodeLayer = $('#nodes');
const edgeLayer = $('#edges');
const STORAGE_KEY = 'topology-lab-v1';
const TYPE_LABEL = { client: '客户端', router: '路由器', server: '服务器' };
const TYPE_ICON = { client: '⌘', router: '◇', server: '▣' };
const NODE_W = 154, NODE_H = 77;
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
function canConnect(id) { const n = nodeById(id); return n && (n.type === 'router' || degree(id) === 0); }
function chooseSource(id) {
  if (!canConnect(id)) { toast('客户端和服务器只能连接一条线'); return; }
  pendingSource = id; connectMode = true; $('#connectBtn').classList.add('active'); viewport.classList.add('connecting'); $('#canvasHint').textContent = `已选择 ${nodeById(id).name}，点击目标节点完成连接 · Esc 取消`;
  renderNodes();
}
function stopConnecting() { pendingSource = null; connectMode = false; $('#connectBtn').classList.remove('active'); viewport.classList.remove('connecting'); $('#canvasHint').textContent = '拖动节点布局 · 点击节点侧边的连接点创建连线'; renderNodes(); }
function newLink(source, target) {
  if (source === target) { toast('请选择另一个节点'); return; }
  if (topology.links.some(l => [l.source, l.target].includes(source) && [l.source, l.target].includes(target))) { toast('这两个节点已经连接'); return; }
  if (!canConnect(source) || !canConnect(target)) { toast('客户端和服务器只能连接一条线'); return; }
  let i = 1;
  while (topology.links.some(l => l.subnet === `10.200.${i}.0/24`)) i++;
  if (i > 254) { toast('自动网段已用完，请手动修改现有网段'); return; }
  const id = nextId('link', topology.links);
  const hex = i.toString(16).padStart(2, '0');
  const link = { id, source, target, subnet: `10.200.${i}.0/24`, sourceIp: `10.200.${i}.10`, targetIp: `10.200.${i}.11`, sourceMac: `02:42:c8:00:${hex}:01`, targetMac: `02:42:c8:00:${hex}:02` };
  topology.links.push(link); selection = { kind: 'link', id }; save(); stopConnecting(); render(); toast('已连接节点，可在属性面板编辑地址');
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
function renderNodes() {
  nodeLayer.replaceChildren();
  for (const node of topology.nodes) {
    const el = document.createElement('div');
    el.className = `topology-node ${node.type}${selection?.kind === 'node' && selection.id === node.id ? ' selected' : ''}${pendingSource === node.id ? ' pending' : ''}`;
    el.style.left = `${Number(node.x) || 0}px`; el.style.top = `${Number(node.y) || 0}px`; el.dataset.nodeId = node.id;
    el.innerHTML = `<span class="node-icon">${TYPE_ICON[node.type] || '?'}</span><span class="node-copy"><strong>${esc(node.name)}</strong><span>${TYPE_LABEL[node.type] || node.type}${node.gui ? ' · GUI' : ''} · ${degree(node.id)} 条连接</span></span><span class="node-port" title="从此节点连接"></span>`;
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
    body.innerHTML = `<div class="inspector-body"><div class="inspector-kicker">NODE / ${esc(node.id)}</div><div class="inspector-heading">${esc(node.name)}</div><label class="form-field"><span>节点名称</span><input data-node-field="name" maxlength="60" value="${esc(node.name)}"></label><label class="form-field"><span>节点类型</span><select data-node-field="type">${Object.keys(TYPE_LABEL).map(type => `<option value="${type}" ${node.type === type ? 'selected' : ''}>${TYPE_LABEL[type]}</option>`).join('')}</select></label>${node.type === 'router' ? '<div class="form-help">自动使用随项目打包的 OpenWrt ARM64 rootfs。</div>' : `<label class="gui-option"><input type="checkbox" data-node-field="gui" ${node.gui ? 'checked' : ''}><span><strong>需要 GUI 桌面</strong><small>使用 kasmweb/ubuntu-focal-desktop:1.16.0</small></span></label>`}<div class="form-help">客户端、服务器可连接一条线；路由器可连接多个网段。</div><div class="inspector-divider"></div><div class="endpoint-title">连接接口 <small>${connected.length} 个网络接口</small></div>${connected.map(l => `<div class="form-help" style="margin:0 0 9px">${esc(l.subnet)} · ${esc(l.source === node.id ? l.sourceIp : l.targetIp)}</div>`).join('') || '<div class="form-help">尚无连接。点击节点右侧圆点开始连接。</div>'}</div>`;
    body.querySelector('[data-node-field="name"]').addEventListener('input', event => { node.name = event.target.value; save(); renderNodes(); });
    body.querySelector('[data-node-field="type"]').addEventListener('change', event => { if (event.target.value !== 'router' && degree(node.id) > 1) { toast('多连接节点必须保持为路由器'); event.target.value = node.type; return; } node.type = event.target.value; if (node.type === 'router') node.gui = false; save(); render(); });
    body.querySelector('[data-node-field="gui"]')?.addEventListener('change', event => { node.gui = event.target.checked; save(); renderNodes(); });
    return;
  }
  const link = topology.links.find(l => l.id === selection.id);
  if (!link) { selection = null; renderInspector(); return; }
  const a = nodeById(link.source), b = nodeById(link.target);
  body.innerHTML = `<div class="inspector-body"><div class="inspector-kicker">LINK / ${esc(link.id)}</div><div class="inspector-heading">${esc(a.name)} ↔ ${esc(b.name)}</div><label class="form-field"><span>网络网段 CIDR</span><input data-link-field="subnet" value="${esc(link.subnet)}" spellcheck="false"></label><div class="form-help">每条连接独占一个 Docker bridge 网络。</div><div class="inspector-divider"></div>${['source','target'].map((side, i) => `<div class="endpoint-title">${i ? esc(b.name) : esc(a.name)} <small>${i ? '目标接口' : '源接口'}</small></div><label class="form-field"><span>IPv4 地址</span><input data-link-field="${side}Ip" value="${esc(link[side + 'Ip'])}" spellcheck="false"></label><label class="form-field"><span>MAC 地址</span><input data-link-field="${side}Mac" value="${esc(link[side + 'Mac'])}" spellcheck="false"></label>${i ? '' : '<div class="inspector-divider"></div>'}`).join('')}</div>`;
  body.querySelectorAll('[data-link-field]').forEach(input => input.addEventListener('input', event => { link[event.target.dataset.linkField] = event.target.value; save(); renderEdges(); }));
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
$('#deleteBtn').addEventListener('click', deleteSelected); $('#previewBtn').addEventListener('click', preview); $('#downloadBtn').addEventListener('click', download);
$('#copyBtn').addEventListener('click', async () => { if (!generated || !activeFile) return; await navigator.clipboard.writeText(generated.files[activeFile]); toast('已复制文件内容'); });
$('#sampleBtn').addEventListener('click', () => { topology = demoTopology(); selection = null; stopConnecting(); save(); render(); fitView(); toast('已加载示例拓扑'); });
$('#clearBtn').addEventListener('click', () => { if (!confirm('清空当前拓扑？此操作会删除所有节点和连线。')) return; topology = {nodes:[],links:[]}; selection = null; stopConnecting(); save(); render(); $('#fileList').innerHTML = '<div class="empty-file">尚未生成文件</div>'; $('#codeContent').textContent = '添加节点与连线后，点击“刷新预览”。'; $('#warnings').textContent = ''; toast('画布已清空'); });
document.addEventListener('keydown', event => { if (event.key === 'Escape') stopConnecting(); if ((event.key === 'Delete' || event.key === 'Backspace') && !['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)) deleteSelected(); });
render(); requestAnimationFrame(fitView);
