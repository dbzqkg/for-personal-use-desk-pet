// 历史对话查看窗口逻辑
(async () => {
  const listEl = document.getElementById('list');
  const countEl = document.getElementById('count');

  function fmtTime(iso) {
    try {
      const d = new Date(iso);
      const p = n => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    } catch (e) { return ''; }
  }

  async function load() {
    const items = await window.petAPI.chatGetHistory();
    listEl.textContent = '';
    if (!items || !items.length) {
      const d = document.createElement('div');
      d.className = 'empty';
      d.textContent = '暂无对话记录';
      listEl.appendChild(d);
      countEl.textContent = '0 条';
      return;
    }
    countEl.textContent = items.length + ' 条';
    for (const m of items) {
      const box = document.createElement('div');
      box.className = 'msg ' + (m.role === 'user' ? 'user' : 'assistant');
      const meta = document.createElement('div');
      meta.className = 'meta';
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = m.role === 'user' ? '你' : 'テト';
      const t = document.createElement('span');
      t.textContent = fmtTime(m.time);
      meta.appendChild(who);
      meta.appendChild(t);
      const body = document.createElement('div');
      body.textContent = m.content || '';
      box.appendChild(meta);
      box.appendChild(body);
      listEl.appendChild(box);
    }
    listEl.scrollTop = listEl.scrollHeight;
  }

  document.getElementById('refresh').addEventListener('click', load);
  document.getElementById('clear').addEventListener('click', async () => {
    if (!confirm('确认清空全部历史对话记录？此操作同时清空宠物记忆与完整记录。')) return;
    await window.petAPI.chatClearHistory();
    load();
  });

  await load();
})();
