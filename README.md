# PhoneSpeaker 🔊

Stream audio from your laptop to any phone — in real-time, no app install needed.

## How it works

- Your **laptop** captures system audio (or mic) and streams it via WebRTC
- Your **phone** opens a browser tab and plays the audio through its speaker
- A lightweight **Node.js server** handles the initial WebRTC handshake (signalling)
- After that, audio flows peer-to-peer — the server is barely involved

## Setup

```bash
git clone https://github.com/silasamoah/Sonno.git
```

```bash
cd Sonno
```

### 1. Install dependencies

```bash
npm install
```

### 2. Start the server

```bash
npm start
```

### 3. Open the sender on your laptop

```bash
http://localhost:3000/sender.html
```

### 4. Open the receiver on your phone

Your **laptop and phone must be on the same Wi-Fi network.**

Find your laptop's local IP (e.g. `192.168.1.42`) and open:

```bash
http://192.168.1.42:3000/receiver.html
```

Tap **Connect**.

---

## Usage

1. On the **laptop sender page**:
   - Choose audio source: **System Audio** (everything playing) or **Microphone**
   - Click **Go Live**
   - For system audio: in the screen-share picker, **check "Share audio"** ✅
   - The receiver link + QR code will appear

2. On the **phone receiver page**:
   - Open the link (or scan the QR)
   - Tap **Connect** — audio starts playing immediately (phones can connect before the sender goes live and will start playing once it does)

3. Use the **volume slider** on the phone to adjust playback (on iPhone, use the hardware volume buttons).

4. You can **lock the phone or switch apps** — keep the receiver tab open and audio keeps playing. Lock-screen / notification controls can pause and resume it.

---

## Tips

- **System audio on Chrome**: You must share a browser tab or entire screen and check "Share audio" in the dialog. Only Chrome on desktop supports tab audio capture.
- **Latency vs. dropouts**: The receiver's **Buffer** setting trades delay for smoothness. *Balanced* (default) suits most Wi-Fi; pick *Smooth* if audio still drops with the screen off, or *Low delay* when watching video on the laptop. The small stats line under the status shows ping, packet loss, buffer and dropouts.
- **Connection drops**: Both pages reconnect on their own. A server or Wi-Fi blip does not interrupt audio that is already flowing; a broken audio path is repaired automatically (ICE restart, then a fresh connection).
- **Laptop on Wi-Fi (Windows)**: If audio still stutters, set *Power Options → Wireless Adapter Settings → Power Saving Mode* to **Maximum Performance**, or use Ethernet.
- **Multiple phones**: You can connect as many phones as you want. There is one shared session — a new sender replaces the previous one.
- **Install as an app**: The receiver is a PWA — use *Add to Home Screen* / *Install app* in the phone's browser to get a full-screen PhoneSpeaker icon. Browsers only allow a full install over HTTPS (see below); over plain `http://<laptop-ip>` you get a home-screen shortcut instead.
- **HTTPS on your network**: If `certs/cert.pem` and `certs/key.pem` exist, the server runs on HTTPS. Create them with [mkcert](https://github.com/FiloSottile/mkcert) (`mkcert -install` once, then from `certs/`: `mkcert -cert-file cert.pem -key-file key.pem localhost 127.0.0.1 <laptop-ip>`). The phone must trust mkcert's root CA: copy `rootCA.pem` from `mkcert -CAROOT` to the phone and install it (Android: *Settings → Security → Install a certificate → CA certificate*; iPhone: install the profile, then turn it on under *Settings → General → About → Certificate Trust Settings*). If the laptop's IP changes, generate the cert again. Android treats installed web apps on the same host as one app even when the ports differ. If Chrome says the app is already installed, another web app from your laptop's IP is installed on the phone. Uninstall that one first.
- **HTTPS for production**: If deploying beyond localhost, you'll need HTTPS (WebRTC requires it). Use [ngrok](https://ngrok.com) for quick testing: `ngrok http 3000`.

## Tech Stack

- **Signalling**: Node.js + `ws` (WebSocket)
- **Audio transport**: WebRTC `RTCPeerConnection`
- **Capture**: `getDisplayMedia()` for system audio, `getUserMedia()` for mic
- **Frontend**: Vanilla HTML/CSS/JS — no framework, no bundler
