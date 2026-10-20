/** 聊天面板 */
export class ChatPanel {
  constructor({ client, listEl, formEl, inputEl }) {
    this.client = client;
    this.listEl = listEl;
    this.formEl = formEl;
    this.inputEl = inputEl;

    this.formEl.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = this.inputEl.value.trim();
      if (!text) return;
      this.client.send('chat', { text });
      this.inputEl.value = '';
    });

    this.client.on('chat', (msg) => this.append(msg));
  }

  append(msg) {
    const div = document.createElement('div');
    div.className = 'chat-msg' + (msg.system ? ' system' : '');
    if (msg.system) {
      div.textContent = msg.text;
    } else {
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = msg.from?.name || '匿名';
      const text = document.createElement('span');
      text.textContent = msg.text;
      div.append(who, text);
    }
    this.listEl.appendChild(div);
    this.listEl.scrollTop = this.listEl.scrollHeight;
    while (this.listEl.children.length > 300) this.listEl.removeChild(this.listEl.firstChild);
  }
}
