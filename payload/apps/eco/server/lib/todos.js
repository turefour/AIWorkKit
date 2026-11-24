'use strict';

/**
 * AIWorkKit Eco - automatic task breakdown extraction.
 *
 * Agents that maintain a checklist (todo / plan / task list) reveal the real,
 * quantified structure of the current task in the tool payload. This module
 * normalizes that payload defensively:
 *
 *  - the array may sit under several key names (todos / items / plan / tasks ...)
 *  - items may be strings or objects
 *  - the status field may be `status` / `state` / `completed`
 *
 * When nothing looks like a checklist the extractor returns null, so unrelated
 * arrays (file lists, search results) are never mistaken for a task plan.
 */

const STATUS_MAP = {
  completed: 'completed',
  complete: 'completed',
  done: 'completed',
  success: 'completed',
  finished: 'completed',
  in_progress: 'in_progress',
  inprogress: 'in_progress',
  'in-progress': 'in_progress',
  active: 'in_progress',
  running: 'in_progress',
  doing: 'in_progress',
  current: 'in_progress',
  pending: 'pending',
  todo: 'pending',
  open: 'pending',
  queued: 'pending',
  not_started: 'pending',
  blocked: 'pending',
  cancelled: 'cancelled',
  canceled: 'cancelled',
  skipped: 'cancelled',
  failed: 'failed',
  error: 'failed'
};

const ARRAY_KEYS = ['todos', 'todo_list', 'todosList', 'items', 'plan', 'steps', 'tasks', 'checklist', 'list'];
const TEXT_KEYS = ['content', 'text', 'title', 'description', 'task', 'label', 'name', 'summary'];
const STATUS_KEYS = ['status', 'state'];

function mapStatus(value) {
  const key = String(value || '').trim().toLowerCase().replace(/\s+/g, '_');
  return STATUS_MAP[key] || '';
}

function normalizeItem(item, index, tolerateBareString) {
  if (typeof item === 'string') {
    if (!tolerateBareString) return null;
    const text = item.trim();
    return text ? { index, text: text.slice(0, 200), status: 'pending' } : null;
  }
  if (!item || typeof item !== 'object') return null;

  let text = '';
  for (const key of TEXT_KEYS) {
    if (typeof item[key] === 'string' && item[key].trim()) {
      text = item[key];
      break;
    }
  }
  if (!text && typeof item.id === 'string') text = item.id;
  if (!text) return null;

  let status = '';
  for (const key of STATUS_KEYS) {
    const mapped = mapStatus(item[key]);
    if (mapped) {
      status = mapped;
      break;
    }
  }
  if (!status && typeof item.completed === 'boolean') status = item.completed ? 'completed' : 'pending';
  if (!status && typeof item.done === 'boolean') status = item.done ? 'completed' : 'pending';
  if (!status) return null;

  return { index, text: String(text).trim().slice(0, 200), status };
}

/**
 * @param {object} input  raw tool input
 * @param {string} toolName tool name, used to decide how forgiving to be
 * @returns {Array<{index:number,text:string,status:string}>|null}
 */
function extractTodos(input, toolName) {
  if (!input || typeof input !== 'object') return null;
  const name = String(toolName || '').toLowerCase();
  const nameHint = /todo|plan|task|checklist|step/.test(name);

  const arrays = [];
  for (const key of ARRAY_KEYS) {
    if (Array.isArray(input[key])) arrays.push(input[key]);
  }
  if (!arrays.length) {
    // Some clients nest the payload one level deeper.
    for (const key of ['params', 'arguments', 'input']) {
      if (input[key] && typeof input[key] === 'object') {
        const nested = extractTodos(input[key], toolName);
        if (nested) return nested;
      }
    }
    return null;
  }

  for (const list of arrays) {
    if (!list.length) continue;
    const normalized = [];
    for (let i = 0; i < list.length; i += 1) {
      const item = normalizeItem(list[i], i, nameHint);
      if (!item) {
        normalized.length = 0;
        break;
      }
      normalized.push(item);
    }
    if (normalized.length) return normalized;
  }
  return null;
}

function summarize(todos) {
  const total = todos.length;
  const done = todos.filter((t) => t.status === 'completed').length;
  const active = todos.find((t) => t.status === 'in_progress') || todos.find((t) => t.status === 'pending') || null;
  return {
    total,
    done,
    active,
    percent: total ? Math.round((done / total) * 1000) / 10 : 0
  };
}

module.exports = { extractTodos, summarize, mapStatus };
