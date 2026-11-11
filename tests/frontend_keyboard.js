const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const source = fs.readFileSync(process.argv[2], 'utf8');

class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {};
    this.style = {}; this.attributes = {}; this.listeners = {}; this.className = '';
    this.classList = {add() {}, remove() {}};
  }
  setAttribute(name, value) { this.attributes[name] = String(value); if (name === 'class') this.className = String(value); }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  appendChild(child) { child.parent = this; this.children.push(child); return child; }
  append(...children) { children.forEach(child => this.appendChild(child)); }
  replaceChildren() { this.children = []; }
  set innerHTML(value) {
    this.html = value;
    if (value.includes('node-port')) {
      this.port = new Element('span'); this.port.className = 'node-port'; this.port.parent = this;
    }
  }
  querySelector(selector) { return selector === '.node-port' ? this.port : null; }
  querySelectorAll(selector) {
    return this.children.flatMap(child => [
      ...(selector === '.edge-hit' && child.className === 'edge-hit' ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }
  cloneNode() { const copy = new Element(this.tagName); copy.attributes = {...this.attributes}; return copy; }
  closest(selector) { return selector === '.topology-node' && this.className.includes('topology-node') ? this : this.parent?.closest(selector); }
  focus() { document.activeElement = this; }
  dispatch(name, properties = {}) {
    const event = {target:this, key:'', preventDefault() { this.prevented = true; }, stopPropagation() {}, ...properties};
    this.listeners[name]?.(event); return event;
  }
  click() { this.dispatch('click'); }
}
const document = {
  activeElement: null, listeners: {},
  createElement: tag => new Element(tag), createElementNS: (_, tag) => new Element(tag),
  addEventListener(name, callback) { this.listeners[name] = callback; },
};
const elements = Object.fromEntries(['connectBtn', 'canvasHint'].map(id => [id, new Element()]));
const nodeLayer = new Element(), edgeLayer = new Element('svg'), viewport = new Element();
const topology = {nodes:[
  {id:'client-1', name:'客户端', type:'client', x:10, y:10},
  {id:'router-1', name:'路由器', type:'router', x:220, y:10},
], links:[]};
const context = {
  document, nodeLayer, edgeLayer, viewport, topology,
  $: selector => elements[selector.slice(1)],
  TYPE_LABEL:{client:'客户端',router:'路由器',server:'服务器',switch:'交换机'},
  TYPE_ICON:{client:'⌘',router:'◇'}, NODE_W:154, NODE_H:100,
  selection:null, pendingSource:null, connectMode:false,
  nodeById:id => topology.nodes.find(node => node.id === id),
  degree:id => topology.links.filter(link => link.source === id || link.target === id).length,
  nextId:(prefix, values) => `${prefix}-${values.length + 1}`,
  esc:value => String(value), save() {}, toast(message) { context.lastToast = message; },
  renderInspector() {}, worldPoint() { return {x:0,y:0}; },
};
context.render = () => { context.renderNodes(); context.renderEdges(); };
vm.createContext(context);
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));
vm.runInContext(section('function canConnect(', 'function addNode('), context);
vm.runInContext(section('function nodeIps(', 'function routerMirrorCandidates('), context);
const connectHandler = source.split('\n').find(line => line.startsWith("$('#connectBtn').addEventListener('click'"));
const keyboardHandler = source.split('\n').find(line => line.startsWith("document.addEventListener('keydown'"));
vm.runInContext(connectHandler + '\n' + keyboardHandler, context);

context.render();
let node = nodeLayer.children[0]; node.focus();
assert(node.dispatch('keydown', {key:'Enter'}).prevented);
assert.equal(context.selection.id, 'client-1');
assert.strictEqual(document.activeElement, nodeLayer.children[0], 'node focus restored after Enter');
nodeLayer.children[1].focus(); nodeLayer.children[1].dispatch('keydown', {key:' '});
assert.equal(context.selection.id, 'router-1');
assert.strictEqual(document.activeElement, nodeLayer.children[1], 'node focus restored after Space');

elements.connectBtn.click();
assert.equal(elements.connectBtn.attributes['aria-pressed'], 'true');
nodeLayer.children[0].focus(); nodeLayer.children[0].dispatch('keydown', {key:'Enter'});
assert.equal(context.pendingSource, 'client-1');
assert.strictEqual(document.activeElement, nodeLayer.children[0], 'source focus restored');
nodeLayer.children[1].focus(); nodeLayer.children[1].dispatch('keydown', {key:' '});
assert.equal(topology.links.length, 1);
assert.equal(topology.links[0].source, 'client-1');
assert.equal(topology.links[0].target, 'router-1');
assert.strictEqual(document.activeElement, nodeLayer.children[1], 'target focus restored');
assert.equal(elements.connectBtn.attributes['aria-pressed'], 'false');

let edge = edgeLayer.querySelectorAll('.edge-hit')[0]; edge.focus(); edge.dispatch('keydown', {key:'Enter'});
assert.equal(context.selection.kind, 'link');
assert.strictEqual(document.activeElement, edgeLayer.querySelectorAll('.edge-hit')[0], 'edge focus restored');
edgeLayer.querySelectorAll('.edge-hit')[0].dispatch('keydown', {key:' '});
assert.equal(context.selection.id, topology.links[0].id);
assert.strictEqual(document.activeElement, edgeLayer.querySelectorAll('.edge-hit')[0]);

elements.connectBtn.click(); nodeLayer.children[1].focus(); nodeLayer.children[1].dispatch('keydown', {key:'Enter'});
assert.equal(context.pendingSource, 'router-1');
document.listeners.keydown({key:'Escape'});
assert.equal(context.pendingSource, null);
assert.equal(context.connectMode, false);
assert.equal(elements.connectBtn.attributes['aria-pressed'], 'false');
assert.strictEqual(document.activeElement, nodeLayer.children[1], 'node focus restored after Escape');
