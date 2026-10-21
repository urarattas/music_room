/**
 * WebRTC Mesh 语音（开麦）
 * 新加入者向房间内既有成员发起 offer，避免 glare。
 */
const ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
];

export class VoiceRoom extends EventTarget {
  constructor({ client, iceServers = ICE_SERVERS } = {}) {
    super();
    this.client = client;
    this.iceServers = iceServers;
    this.localStream = null;
    this.peers = new Map(); // peerId -> { pc, stream, makingOffer, polite }
    this.micEnabled = false;
    this._pendingCandidates = new Map(); // peerId -> RTCIceCandidateInit[]
    this._levelCtx = null;
    this._levelRaf = null;
    this._attached = false;

    this._onSignal = (msg) => this.handleSignal(msg);
    this._onUsers = (msg) => this.handleUsers(msg);
    // 始终监听信令：即使用户未开麦，也要应答对方的 offer，
    // 这样才能单向收到别人的语音。
    this.attach();
  }

  emit(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { detail }));
  }

  on(name, handler) {
    this.addEventListener(name, (e) => handler(e.detail));
    return this;
  }

  attach() {
    if (this._attached) return;
    this._attached = true;
    this.client.on('signal', this._onSignal);
    this.client.on('users', this._onUsers);
  }

  detach() {
    if (!this._attached) return;
    this._attached = false;
    this.client.off?.('signal', this._onSignal);
    this.client.off?.('users', this._onUsers);
  }

  /** 房间成员变化：开麦状态下主动向新成员发起连接 */
  handleUsers() {
    if (!this.micEnabled) return;
    for (const u of this._knownUsers()) {
      if (!this.peers.has(u.id)) {
        this._createPeer(u.id, true);
      }
    }
  }

  _knownUsers() {
    const users = this.client.knownUsers || [];
    return users.filter((u) => u.id !== this.client.selfId);
  }

  /** 开始开麦：获取麦克风并与所有其他成员建立连接 */
  async start() {
    if (this.micEnabled) return true;
    if (!navigator.mediaDevices?.getUserMedia) {
      this.emit('error', { msg: '当前浏览器不支持麦克风采集', fatal: true });
      return false;
    }
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
    } catch (err) {
      this.emit('error', { msg: `无法访问麦克风：${err?.message || err}`, fatal: true });
      return false;
    }
    this.micEnabled = true;
    this.attach();
    this.client.send('rtc.mic', { on: true });
    this.emit('localStream', this.localStream);
    this._startLevelMeter();

    // 已存在的连接补上音轨
    for (const [id, peer] of this.peers) {
      this._addLocalTracks(peer, id);
    }
    // 与尚未连接的成员建立连接（失败不影响开麦本身）
    for (const u of this._knownUsers()) {
      if (this.peers.has(u.id)) continue;
      try {
        await this._createPeer(u.id, true);
      } catch (err) {
        this.emit('error', { msg: `建立连接失败：${err?.message}`, fatal: false });
      }
    }
    return true;
  }

  /** 停止：关闭所有连接并释放麦克风 */
  async stop() {
    this.micEnabled = false;
    this.client.send('rtc.mic', { on: false });
    this._stopLevelMeter();
    for (const [, peer] of this.peers) {
      try {
        peer.pc.close();
      } catch {
        /* ignore */
      }
    }
    this.peers.clear();
    this._pendingCandidates.clear();
    if (this.localStream) {
      for (const t of this.localStream.getTracks()) t.stop();
      this.localStream = null;
    }
    this._emitPeers();
  }

  setMicEnabled(on) {
    if (!this.localStream) {
      if (on) return this.start();
      return;
    }
    for (const track of this.localStream.getAudioTracks()) {
      track.enabled = !!on;
    }
    this.micEnabled = !!on;
    this.client.send('rtc.mic', { on: !!on });
  }

  _addLocalTracks(peer, peerId) {
    if (!this.localStream) return;
    for (const track of this.localStream.getTracks()) {
      const already = peer.pc.getSenders().some((s) => s.track === track);
      if (!already) {
        try {
          peer.pc.addTrack(track, this.localStream);
        } catch {
          /* ignore */
        }
      }
    }
    void peerId;
  }

  async _createPeer(peerId, initiator) {
    if (this.peers.has(peerId)) return this.peers.get(peerId);
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    // 完美协商（perfect negotiation）：发起方 impolite，应答方 polite
    const peer = {
      pc,
      stream: null,
      polite: !initiator,
      makingOffer: false,
      ignoreOffer: false,
    };
    this.peers.set(peerId, peer);

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.client.send('rtc.signal', {
          to: peerId,
          data: { type: 'candidate', candidate: e.candidate.toJSON() },
        });
      }
    };

    pc.ontrack = (e) => {
      const [stream] = e.streams;
      // 同一 peer 可能触发多次 ontrack（重新协商），
      // 只保留第一次的流，避免出现重复音轨（声音叠加）
      if (peer.stream === stream) {
        this.emit('remoteStream', { id: peerId, stream, existing: true });
        return;
      }
      peer.stream = stream;
      this.emit('remoteStream', { id: peerId, stream, existing: false });
      this._emitPeers();
    };

    pc.onconnectionstatechange = () => {
      this._emitPeers();
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this.peers.delete(peerId);
        this._emitPeers();
      }
    };

    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        this.client.send('rtc.signal', {
          to: peerId,
          data: { type: 'offer', sdp: pc.localDescription.sdp },
        });
      } catch (err) {
        this.emit('error', { msg: `协商失败：${err?.message}`, fatal: false });
      } finally {
        peer.makingOffer = false;
      }
    };

    // 添加本地音轨（会触发 negotiationneeded）
    this._addLocalTracks(peer, peerId);
    return peer;
  }

  async handleSignal(msg) {
    const { from, data } = msg || {};
    if (!from || !data) return;
    const peerId = from;

    if (data.type === 'offer') {
      const peer = await this._createPeer(peerId, false);
      const pc = peer.pc;
      const offerCollision = peer.makingOffer || pc.signalingState !== 'stable';
      peer.ignoreOffer = !peer.polite && offerCollision;
      if (peer.ignoreOffer) return;
      try {
        if (offerCollision) {
          await pc.setLocalDescription({ type: 'rollback' });
        }
        await pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
        await pc.setLocalDescription();
        this.client.send('rtc.signal', {
          to: peerId,
          data: { type: 'answer', sdp: pc.localDescription.sdp },
        });
        await this._flushCandidates(peerId, pc);
      } catch (err) {
        this.emit('error', { msg: `应答失败：${err?.message}`, fatal: false });
      }
    } else if (data.type === 'answer') {
      const peer = this.peers.get(peerId);
      if (!peer) return;
      const pc = peer.pc;
      if (pc.signalingState === 'have-local-offer') {
        try {
          await pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
          await this._flushCandidates(peerId, pc);
        } catch (err) {
          this.emit('error', { msg: `设置远端描述失败：${err?.message}`, fatal: false });
        }
      } else if (pc.signalingState === 'stable') {
        await this._flushCandidates(peerId, pc);
      }
    } else if (data.type === 'candidate' && data.candidate) {
      const peer = this.peers.get(peerId);
      if (peer && peer.pc.remoteDescription) {
        try {
          await peer.pc.addIceCandidate(data.candidate);
        } catch {
          /* ignore */
        }
      } else {
        const list = this._pendingCandidates.get(peerId) || [];
        list.push(data.candidate);
        this._pendingCandidates.set(peerId, list);
      }
    }
  }

  async _flushCandidates(peerId, pc) {
    const list = this._pendingCandidates.get(peerId);
    if (!list?.length) return;
    for (const c of list) {
      try {
        await pc.addIceCandidate(c);
      } catch {
        /* ignore */
      }
    }
    this._pendingCandidates.delete(peerId);
  }

  _emitPeers() {
    this.emit('peers', [...this.peers.entries()].map(([id, p]) => ({
      id,
      connected: p.pc.connectionState === 'connected',
      state: p.pc.connectionState,
    })));
  }

  /** 成员离开时清理其连接与音轨 */
  removePeer(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    try {
      peer.pc.close();
    } catch {
      /* ignore */
    }
    this.peers.delete(peerId);
    this._pendingCandidates.delete(peerId);
    this.emit('peerLeft', { id: peerId });
    this._emitPeers();
  }

  _startLevelMeter() {
    if (!this.localStream) return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this._levelCtx = new Ctx();
      const src = this._levelCtx.createMediaStreamSource(this.localStream);
      const analyser = this._levelCtx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      const buf = new Uint8Array(analyser.frequencyBinCount);
      const loop = () => {
        if (!this._levelCtx) return;
        analyser.getByteTimeDomainData(buf);
        let peak = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = Math.abs(buf[i] - 128) / 128;
          if (v > peak) peak = v;
        }
        this.emit('level', peak);
        this._levelRaf = requestAnimationFrame(loop);
      };
      loop();
    } catch {
      /* ignore */
    }
  }

  _stopLevelMeter() {
    cancelAnimationFrame(this._levelRaf);
    try {
      this._levelCtx?.close();
    } catch {
      /* ignore */
      }
    this._levelCtx = null;
  }
}
