// AI 对话设置窗口逻辑
(async () => {
  const cfg = await window.petAPI.chatGetConfig();
  document.getElementById('apiKey').value = cfg.apiKey || '';
  document.getElementById('model').value = cfg.model || 'deepseek-v4-flash';
  document.getElementById('persona').value = cfg.persona || 'default';
  document.getElementById('historyRounds').value = String(cfg.historyRounds || 20);
  document.getElementById('bubbleTime').value = String(cfg.bubbleTime || 8);
  document.getElementById('voice').checked = cfg.voice !== false;
  document.getElementById('webSearch').checked = cfg.webSearch !== false;
  document.getElementById('thinking').checked = cfg.thinking === true;
  document.getElementById('micMode').value = cfg.micMode === 'hold' || cfg.micMode === 'always' ? cfg.micMode : 'click';
  const ttsDelayEl = document.getElementById('ttsEchoDelay');
  ttsDelayEl.value = String(typeof cfg.ttsEchoDelay === 'number' ? cfg.ttsEchoDelay : 0.1);
  const ttsDelayValEl = document.getElementById('ttsEchoDelayVal');
  const ttsDelayShow = () => { if (ttsDelayValEl) ttsDelayValEl.textContent = ttsDelayEl.value; };
  ttsDelayShow();
  ttsDelayEl.addEventListener('input', ttsDelayShow);
  document.getElementById('vadThold').value = String(typeof cfg.vadThold === 'number' ? cfg.vadThold : 0.75);

  // 枚举音频设备
  async function loadDevices() {
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => {});
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inSel = document.getElementById('inputDevice');
      const outSel = document.getElementById('outputDevice');
      for (const d of devices) {
        const opt = document.createElement('option');
        opt.value = d.deviceId;
        opt.textContent = d.label || (d.kind === 'audioinput' ? '输入设备 ' + inSel.length : '输出设备 ' + outSel.length);
        if (d.kind === 'audioinput') inSel.appendChild(opt);
        else if (d.kind === 'audiooutput') outSel.appendChild(opt);
      }
      inSel.value = cfg.inputDevice || '';
      outSel.value = cfg.outputDevice || '';
    } catch (e) {}
  }
  await loadDevices();

  document.getElementById('save').addEventListener('click', async () => {
    const newCfg = {
      apiKey: document.getElementById('apiKey').value.trim(),
      model: document.getElementById('model').value,
      persona: document.getElementById('persona').value,
      historyRounds: Number(document.getElementById('historyRounds').value),
      bubbleTime: Number(document.getElementById('bubbleTime').value),
      voice: document.getElementById('voice').checked,
      inputDevice: document.getElementById('inputDevice').value,
      outputDevice: document.getElementById('outputDevice').value,
      webSearch: document.getElementById('webSearch').checked,
      thinking: document.getElementById('thinking').checked,
      micMode: document.getElementById('micMode').value,
      ttsEchoDelay: Number(document.getElementById('ttsEchoDelay').value),
      vadThold: Number(document.getElementById('vadThold').value),
    };
    const r = await window.petAPI.chatSaveConfig(newCfg);
    const st = document.getElementById('status');
    st.textContent = r && r.ok ? '已保存 ✓' : '保存失败';
    if (r && r.ok) setTimeout(() => window.close(), 600);
  });
})();
