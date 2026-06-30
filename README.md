# Gemini Character RP

A browser-based character roleplay app that can use Google Gemini, Ollama, or LM Studio. Characters, chats, provider settings, and API keys are stored in browser localStorage.

## Features

- Google Gemini provider with current Gemini model choices:
  - `gemini-3.1-flash-lite`
  - `gemini-3.5-flash`
  - `gemini-3.1-pro-preview`
  - Gemini 2.5 Flash options for fallback
- Local AI provider support:
  - Ollama at `http://localhost:11434`
  - LM Studio OpenAI-compatible server at `http://localhost:1234/v1`
- Custom local model names for Gemma, Phi, Llama, Qwen, and any other installed model.
- Single-character chat flow with chat history, regenerate, edit, delete, clear, and new chat actions.
- Character creation, editing, profile pictures, and AI-assisted character context enhancement.
- Personal context for better character continuity.
- Data export/import for backups.

## Running Locally

1. Install dependencies:

   ```bash
   npm install
   ```

2. Start the local static server:

   ```bash
   npm start
   ```

3. Open `http://127.0.0.1:3000/` in your browser.

Opening `index.html` directly can work for Gemini, but a localhost server is recommended for Ollama and LM Studio browser requests.

## Provider Setup

### Gemini

1. Get an API key from [Google AI Studio](https://aistudio.google.com/).
2. Open Settings.
3. Choose `Google Gemini`.
4. Paste your key, choose a Gemini model, and click Save or Test Configuration.

The app applies thinking minimization automatically. Gemini 2.5 Flash uses `thinkingBudget: 0`; Gemini 3 thinking models use the lowest supported thinking level for their current API support.

### Ollama

1. Install and start Ollama.
2. Pull or create a model, for example:

   ```bash
   ollama pull gemma3:12b
   ollama pull phi4
   ollama pull qwen3:14b
   ```

3. Open Settings.
4. Choose `Ollama (Local)`.
5. Keep the endpoint as `http://localhost:11434` unless you changed it.
6. Enter the exact model name and click Test Configuration.

### LM Studio

1. Open LM Studio and load a model.
2. Start the local server in OpenAI-compatible mode.
3. Open Settings.
4. Choose `LM Studio (Local)`.
5. Use `http://localhost:1234/v1` unless your LM Studio server uses a different port.
6. Enter the loaded model id, or leave `local-model` to use the first model returned by `/v1/models`.
7. Click Test Configuration.

## Phone and Netlify Local Models

A Netlify HTTPS page cannot normally call `http://localhost` or private LAN model servers. Phones also cannot use `localhost` for your PC, because `localhost` points to the phone itself.

Use `local-ai-bridge.user.js` when you want the deployed Netlify app or a phone browser to call Ollama or LM Studio running on your PC:

1. Install Tampermonkey in the browser that opens the app.
2. Open `https://geminicharacterroleplay.netlify.app/`, then install `https://geminicharacterroleplay.netlify.app/local-ai-bridge.user.js`.
3. Keep the phone and PC on the same Wi-Fi.
4. Start Ollama or LM Studio with local-network access enabled on the PC.
5. Find the PC LAN IPv4 address, for example `192.168.1.25`.
6. In Settings, use `http://192.168.1.25:11434` for Ollama or `http://192.168.1.25:1234/v1` for LM Studio.
7. Click Test Configuration before chatting.

For Ollama LAN access on a trusted private network, configure Ollama to listen on the network interface, for example with `OLLAMA_HOST=0.0.0.0:11434`, then restart Ollama. Keep the firewall limited to trusted devices. For LM Studio, enable local-network serving in its server settings if available.

## Privacy

- Gemini requests are sent directly from your browser to Google with your API key.
- Ollama and LM Studio requests are sent to your configured local endpoint.
- No app backend stores your characters or chats.
- Exported backups include localStorage data and may include your Gemini API key. Do not share backups without reviewing them first.

## Notes

- Group chat selection was removed because it was not complete or reliable.
- The old top-k/top-p controls were removed because they were provider-specific and could break model calls.
- Increase the Chat Response Token Limit in Settings if replies are being cut off and your selected model supports longer output.
