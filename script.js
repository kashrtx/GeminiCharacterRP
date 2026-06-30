// Constants
const AI_PROVIDERS = {
    GEMINI: "gemini",
    OLLAMA: "ollama",
    LM_STUDIO: "lmstudio",
};

const LEGACY_GEMINI_MODEL_MAP = {
    "gemini-3-flash-preview": "gemini-3.5-flash",
    "gemini-3-pro-preview": "gemini-3.1-pro-preview",
};

const DEFAULT_GEMINI_MODEL = "gemini-3.1-flash-lite";
const DEFAULT_OLLAMA_URL = "http://localhost:11434";
const DEFAULT_LM_STUDIO_URL = "http://localhost:1234/v1";
const NO_THINKING_INSTRUCTION = "Disable thinking or reasoning mode when the model supports it. Do not output chain-of-thought, hidden reasoning, or <think> blocks. Reply directly and completely in character.";

const STORAGE_KEYS = {
    API_KEY: "gemini_api_key",
    CHARACTERS: "gemini_characters",
    CHATS: "gemini_chats",
    SETTINGS: "gemini_settings",
    PERSONAL_CONTEXT: "gemini_personal_context", // Add new storage key
    CHAT_HISTORY: "gemini_chat_history", // Storage for chat history
    LAST_ACTIVE_CHATS: "gemini_last_active_chats", // Track last active chat per character
};
const VERSION = "1.1.3"; // Fixed character response isolation when switching chats

// App Settings
let appSettings = {
    provider: AI_PROVIDERS.GEMINI,
    modelVersion: DEFAULT_GEMINI_MODEL,
    ollamaBaseUrl: DEFAULT_OLLAMA_URL,
    ollamaModel: "gemma3:12b",
    lmStudioBaseUrl: DEFAULT_LM_STUDIO_URL,
    lmStudioModel: "local-model",
    temperature: 1.0, // 0.5 for a balance between randomness and coherence.
    enhancedContextTokens: 4096, // Controls token length for character context enhancement
    conversationTokens: 4096, // Controls token length for AI responses in chat
    maxTokens: 4096, // For backward compatibility
};

// App State
let state = {
    apiKey: "",
    characters: [],
    chats: {},
    chatHistory: {}, // Store chat history by character ID
    activeCharacters: [],
    activeChat: null,
    selectedCharacters: [], // For character selection in sidebar
    genaiClient: null, // Store the GoogleGenAI client reference
    activeProvider: null,
    isApiConnected: false, // Track API connection status
    personalContext: {
        name: "",
        personality: "",
        context: ""
    },
    lastActiveChats: {}, // Map character IDs to their last active chat IDs
    isResponseInProgress: false, // Track if AI is currently responding
    characterSearchTerm: "", // For character list searching
    characterSortOrder: "createdAt_desc", // Default sort for character list
    pendingResponses: {}, // Track responses being generated in background
};

// Add Gemini AI SDK
// Dynamically load the Gemini AI SDK (new @google/genai)
function loadGeminiSDK() {
    return new Promise((resolve, reject) => {
        if (window.GoogleGenAI) {
            resolve(window.GoogleGenAI);
            return;
        }

        // Use the official Gemini CDN URL for the new SDK
        const script = document.createElement('script');
        script.src = "https://cdn.jsdelivr.net/npm/@google/genai@1.0.0/dist/genai.bundled.js";
        script.async = true;
        script.onload = () => {
            console.log("Gemini GenAI SDK loaded successfully");
            resolve(window.GoogleGenAI);
        };
        script.onerror = () => {
            console.error("Failed to load Gemini GenAI SDK from CDN");
            reject(new Error("Failed to load Gemini GenAI SDK"));
        };
        document.head.appendChild(script);
    });
}

// AI provider setup and request helpers
function getCurrentProvider() {
    return Object.values(AI_PROVIDERS).includes(appSettings.provider)
        ? appSettings.provider
        : AI_PROVIDERS.GEMINI;
}

function getProviderDisplayName(provider = getCurrentProvider()) {
    switch (provider) {
        case AI_PROVIDERS.OLLAMA:
            return "Ollama";
        case AI_PROVIDERS.LM_STUDIO:
            return "LM Studio";
        default:
            return "Google Gemini";
    }
}

function normalizeBaseUrl(url, fallback) {
    const normalized = (url || fallback || "").trim().replace(/\/+$/, "");
    return normalized || fallback;
}

function getGeminiModelName() {
    const requestedModel = appSettings.modelVersion || DEFAULT_GEMINI_MODEL;
    return LEGACY_GEMINI_MODEL_MAP[requestedModel] || requestedModel;
}

function getTokenLimit(value, fallback = 4096) {
    const parsed = parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < 1) return fallback;
    return Math.min(parsed, 65536);
}

function getGeminiThinkingConfig(modelName = getGeminiModelName()) {
    const model = modelName.toLowerCase();

    if (model.includes("gemini-2.5-flash")) {
        return { thinkingBudget: 0 };
    }

    if (model.includes("gemini-3.1-pro")) {
        return { thinkingLevel: "low" };
    }

    if (model.includes("gemini-3")) {
        return { thinkingLevel: "minimal" };
    }

    return null;
}

function buildGeminiGenerationConfig(maxOutputTokens) {
    const config = {
        temperature: appSettings.temperature,
        maxOutputTokens: getTokenLimit(maxOutputTokens || appSettings.conversationTokens || appSettings.maxTokens),
    };

    const thinkingConfig = getGeminiThinkingConfig();
    if (thinkingConfig) {
        config.thinkingConfig = thinkingConfig;
    }

    return config;
}

function getOllamaBaseUrl() {
    return normalizeBaseUrl(appSettings.ollamaBaseUrl, DEFAULT_OLLAMA_URL);
}

function getLMStudioBaseUrl() {
    const baseUrl = normalizeBaseUrl(appSettings.lmStudioBaseUrl, DEFAULT_LM_STUDIO_URL);
    return baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
}

function isProviderConfigured(provider = getCurrentProvider()) {
    if (provider === AI_PROVIDERS.GEMINI) {
        return Boolean(state.apiKey);
    }

    if (provider === AI_PROVIDERS.OLLAMA) {
        return Boolean(getOllamaBaseUrl() && (appSettings.ollamaModel || "").trim());
    }

    if (provider === AI_PROVIDERS.LM_STUDIO) {
        return Boolean(getLMStudioBaseUrl() && (appSettings.lmStudioModel || "").trim());
    }

    return false;
}

function getProviderConfigurationMessage(provider = getCurrentProvider()) {
    if (provider === AI_PROVIDERS.GEMINI) {
        return "Please set your Gemini API key in Settings first.";
    }

    if (provider === AI_PROVIDERS.OLLAMA) {
        return "Please set an Ollama endpoint and model in Settings first.";
    }

    return "Please set an LM Studio endpoint and model in Settings first.";
}

function extractResponseText(result) {
    if (!result) return "";
    if (typeof result.text === "string") return result.text;
    if (typeof result.text === "function") return result.text();
    return result?.candidates?.[0]?.content?.parts?.map(part => part.text || "").join("") || "";
}

async function parseErrorResponse(response) {
    try {
        const text = await response.text();
        return text ? `: ${text.substring(0, 500)}` : "";
    } catch (error) {
        return "";
    }
}

function getLocalProviderBridgeHint() {
    const bridgeActive = Boolean(window.__GCRP_LOCAL_AI_BRIDGE__?.active);
    if (bridgeActive) return "";

    const isSecurePage = window.location.protocol === "https:";
    const host = window.location.hostname;
    const isLocalPage = host === "localhost" || host === "127.0.0.1" || host === "";

    if (isSecurePage) {
        return " If this app is running on Netlify or your phone, install local-ai-bridge.user.js in Tampermonkey and use your PC LAN IP endpoint instead of localhost.";
    }

    if (!isLocalPage) {
        return " If you are using a phone, keep the PC and phone on the same Wi-Fi and use your PC LAN IP endpoint instead of localhost.";
    }

    return "";
}

async function fetchLocalProvider(url, options = {}, providerName = getProviderDisplayName()) {
    try {
        return await fetch(url, options);
    } catch (error) {
        throw new Error(`${providerName} could not be reached at ${url}.${getLocalProviderBridgeHint()} Original error: ${error.message}`);
    }
}

async function initializeAIProvider({ showErrors = true } = {}) {
    const provider = getCurrentProvider();

    if (!isProviderConfigured(provider)) {
        state.isApiConnected = false;
        state.activeProvider = null;
        if (showErrors) showError(getProviderConfigurationMessage(provider));
        return false;
    }

    try {
        if (provider === AI_PROVIDERS.GEMINI) {
            const { GoogleGenAI } = await import("https://esm.run/@google/genai");
            state.genaiClient = new GoogleGenAI({ apiKey: state.apiKey });

            const result = await state.genaiClient.models.generateContent({
                model: getGeminiModelName(),
                contents: "Reply with OK.",
                config: buildGeminiGenerationConfig(48),
            });
            console.log("Gemini connection test successful:", extractResponseText(result).substring(0, 40));
        } else if (provider === AI_PROVIDERS.OLLAMA) {
            state.genaiClient = null;
            await callOllamaChat([{ role: "user", content: "Reply with OK." }], 48);
            console.log("Ollama connection test successful");
        } else if (provider === AI_PROVIDERS.LM_STUDIO) {
            state.genaiClient = null;
            await callLMStudioChat([{ role: "user", content: "Reply with OK." }], 48);
            console.log("LM Studio connection test successful");
        }

        state.activeProvider = provider;
        state.isApiConnected = true;
        checkApiKey();
        return true;
    } catch (error) {
        console.error(`Failed to initialize ${getProviderDisplayName(provider)}:`, error);
        state.isApiConnected = false;
        state.activeProvider = null;
        if (showErrors) showError(`Failed to connect to ${getProviderDisplayName(provider)}: ${error.message}`);
        checkApiKey();
        return false;
    }
}

// Backward-compatible name used by older call sites.
async function initializeGeminiAPI(options) {
    return initializeAIProvider(options);
}

async function ensureAIProviderReady() {
    const provider = getCurrentProvider();
    if (state.isApiConnected && state.activeProvider === provider && (provider !== AI_PROVIDERS.GEMINI || state.genaiClient)) {
        return true;
    }

    const initialized = await initializeAIProvider();
    if (!initialized) {
        throw new Error(`The ${getProviderDisplayName(provider)} provider is not configured or reachable.`);
    }
    return true;
}

async function callGeminiText(prompt, maxOutputTokens) {
    const result = await state.genaiClient.models.generateContent({
        model: getGeminiModelName(),
        contents: prompt,
        config: buildGeminiGenerationConfig(maxOutputTokens),
    });

    return extractResponseText(result);
}

function withNoThinkingSystemMessage(messages) {
    const hasSystemMessage = messages.some(message => message.role === "system");
    if (hasSystemMessage) {
        return messages.map(message => {
            if (message.role !== "system") return message;
            return { ...message, content: `${NO_THINKING_INSTRUCTION}\n\n${message.content}` };
        });
    }

    return [{ role: "system", content: NO_THINKING_INSTRUCTION }, ...messages];
}

async function callOllamaChat(messages, maxOutputTokens) {
    const model = (appSettings.ollamaModel || "").trim();
    const response = await fetchLocalProvider(`${getOllamaBaseUrl()}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            model,
            messages: withNoThinkingSystemMessage(messages),
            stream: false,
            options: {
                temperature: appSettings.temperature,
                num_predict: getTokenLimit(maxOutputTokens || appSettings.conversationTokens || appSettings.maxTokens),
            },
        }),
    });

    if (!response.ok) {
        throw new Error(`Ollama request failed (${response.status})${await parseErrorResponse(response)}`);
    }

    const data = await response.json();
    return data?.message?.content || data?.response || "";
}

async function resolveLMStudioModel() {
    const configuredModel = (appSettings.lmStudioModel || "").trim();
    if (configuredModel && configuredModel !== "local-model") {
        return configuredModel;
    }

    try {
        const response = await fetchLocalProvider(`${getLMStudioBaseUrl()}/models`, {}, "LM Studio");
        if (!response.ok) return configuredModel || "local-model";
        const data = await response.json();
        return data?.data?.[0]?.id || configuredModel || "local-model";
    } catch (error) {
        return configuredModel || "local-model";
    }
}

async function callLMStudioChat(messages, maxOutputTokens) {
    const model = await resolveLMStudioModel();
    const response = await fetchLocalProvider(`${getLMStudioBaseUrl()}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            model,
            messages: withNoThinkingSystemMessage(messages),
            temperature: appSettings.temperature,
            max_tokens: getTokenLimit(maxOutputTokens || appSettings.conversationTokens || appSettings.maxTokens),
            stream: false,
        }),
    });

    if (!response.ok) {
        throw new Error(`LM Studio request failed (${response.status})${await parseErrorResponse(response)}`);
    }

    const data = await response.json();
    return data?.choices?.[0]?.message?.content || "";
}

async function callAIText(prompt, maxOutputTokens) {
    await ensureAIProviderReady();

    const provider = getCurrentProvider();
    if (provider === AI_PROVIDERS.GEMINI) {
        return callGeminiText(prompt, maxOutputTokens);
    }

    const messages = [
        { role: "user", content: prompt },
    ];

    if (provider === AI_PROVIDERS.OLLAMA) {
        return callOllamaChat(messages, maxOutputTokens);
    }

    return callLMStudioChat(messages, maxOutputTokens);
}

async function callAIChat(messages, maxOutputTokens) {
    await ensureAIProviderReady();

    const provider = getCurrentProvider();
    if (provider === AI_PROVIDERS.OLLAMA) {
        return callOllamaChat(messages, maxOutputTokens);
    }

    if (provider === AI_PROVIDERS.LM_STUDIO) {
        return callLMStudioChat(messages, maxOutputTokens);
    }

    const prompt = messages.map(message => `${message.role.toUpperCase()}: ${message.content}`).join("\n\n");
    return callGeminiText(prompt, maxOutputTokens);
}

function convertGeminiHistoryToChatMessages(history) {
    return history.map(entry => ({
        role: entry.role === "model" ? "assistant" : "user",
        content: (entry.parts || []).map(part => part.text || "").join("\n"),
    })).filter(message => message.content.trim());
}

function buildLocalChatMessages(character, history, instructions) {
    const systemPrompt = prepareContextForAPI(character, [], [character]);
    return [
        { role: "system", content: `${systemPrompt}\n\n${NO_THINKING_INSTRUCTION}` },
        ...convertGeminiHistoryToChatMessages(history),
        { role: "user", content: instructions },
    ];
}
// Helper functions
const generateUniqueId = () => Math.random().toString(36).substring(2, 11);

const getStoredItem = (key, defaultValue = null) => {
    try {
        const item = localStorage.getItem(key);
        return item ? JSON.parse(item) : defaultValue;
    } catch (error) {
        console.error(`Error reading from localStorage: ${error}`);
        return defaultValue;
    }
};

const setStoredItem = (key, value) => {
    try {
        localStorage.setItem(key, JSON.stringify(value));
        return true;
    } catch (error) {
        console.error(`Error writing to localStorage: ${error}`);
        return false;
    }
};

// Initialize app
document.addEventListener('DOMContentLoaded', async () => {
    console.log("DOM fully loaded - initializing app");

    // Load data from localStorage
    loadStoredData();

    // Initialize views
    changeView('chat');

    // Update character lists
    updateCharacterLists();

    // Set up event listeners
    setupEventListeners();

    // Add direct event listeners for critical functionality
    setupDirectListeners();

    // Show API warning if needed
    checkApiKey();

    // Initialize the selected AI provider if it is already configured.
    if (isProviderConfigured()) {
        try {
            const success = await initializeAIProvider({ showErrors: false });
            if (success) {
                console.log(`${getProviderDisplayName()} initialized successfully`);
                showSuccess(`${getProviderDisplayName()} connected successfully`, 3000);
            }
        } catch (error) {
            console.error("Error initializing AI provider:", error);
        }
    }

    // Initialize sidebar functionality
    initializeSidebar();

    // Initialize model settings
    initializeModelSettings();
});

// Initialize sidebar functionality
function initializeSidebar() {
    const sidebar = document.getElementById('character-sidebar');
    const toggleBtn = document.getElementById('toggle-sidebar-btn');
    const showCharactersBtn = document.getElementById('show-characters-btn');
    const showChatSidebarBtn = document.getElementById('show-chat-sidebar-btn');
    const chatView = document.getElementById('chat-view');
    const header = document.querySelector('header');

    // Create overlay element
    const overlay = document.createElement('div');
    overlay.className = 'sidebar-overlay';
    document.body.appendChild(overlay);

    // Toggle sidebar function
    function toggleSidebar() {
        sidebar.classList.toggle('sidebar-open');

        // Only use overlay on non-mobile devices
        if (window.innerWidth > 768) {
            overlay.classList.toggle('active');
        }

        // Ensure body scrolling is disabled when sidebar is open
        if (sidebar.classList.contains('sidebar-open')) {
            document.body.style.overflow = 'hidden';
        } else {
            document.body.style.overflow = '';

            // Small delay to ensure overlay is fully hidden before allowing interaction
            if (window.innerWidth > 768) {
                setTimeout(() => {
                    if (!sidebar.classList.contains('sidebar-open')) {
                        overlay.style.display = 'none';
                        setTimeout(() => {
                            overlay.style.display = '';
                        }, 50);
                    }
                }, 300); // Match the transition duration
            }
        }
    }

    // Function to adjust sidebar position based on header height
    function adjustSidebarPosition() {
        if (window.innerWidth < 1024) {
            const headerHeight = header.offsetHeight;
            sidebar.style.top = `${headerHeight}px`;

            // Update main content padding to account for fixed header
            const main = document.querySelector('main');
            if (main) {
                main.style.paddingTop = `${headerHeight}px`;
            }

            // Update height and max-height to ensure proper scrolling
            sidebar.style.height = `calc(100vh - ${headerHeight}px)`;
            sidebar.style.maxHeight = `calc(100vh - ${headerHeight}px)`;
        } else {
            sidebar.style.top = '';
            sidebar.style.height = '';
            sidebar.style.maxHeight = '';

            // Reset main padding for desktop
            const main = document.querySelector('main');
            if (main) {
                main.style.paddingTop = '';
            }
        }
    }

    // Call initially to set the correct position
    adjustSidebarPosition();

    // Add click events for all toggle buttons
    if (toggleBtn) {
        toggleBtn.addEventListener('click', (e) => {
            e.stopPropagation(); // Prevent event bubbling
            toggleSidebar();
        });
    }

    if (showCharactersBtn) {
        showCharactersBtn.addEventListener('click', (e) => {
            e.stopPropagation(); // Prevent event bubbling
            toggleSidebar();
        });
    }

    if (showChatSidebarBtn) {
        showChatSidebarBtn.addEventListener('click', (e) => {
            e.stopPropagation(); // Prevent event bubbling
            toggleSidebar();
        });
    }

    overlay.addEventListener('click', toggleSidebar);

    // Close sidebar on chat start in mobile view
    const originalStartChat = startChat;
    startChat = function () {
        originalStartChat();
        if (window.innerWidth < 1024) { // lg breakpoint
            sidebar.classList.remove('sidebar-open');
            if (window.innerWidth > 768) { // Only manage overlay on non-mobile
                overlay.classList.remove('active');
            }
            chatView.classList.add('chat-active');
        }
    };

    // Handle scroll events to ensure sidebar stays fixed
    window.addEventListener('scroll', () => {
        if (window.innerWidth < 1024) {
            // No need to reposition on scroll since it's fixed in CSS
            // But we can add this as a hook for any future scroll-based adjustments
        }
    });

    // Handle resize events
    window.addEventListener('resize', () => {
        if (window.innerWidth >= 1024) {
            sidebar.classList.remove('sidebar-open');
            if (window.innerWidth > 768) { // Only manage overlay on non-mobile
                overlay.classList.remove('active');
            }
        }
        adjustSidebarPosition();
    });
}

// Set up direct click handlers that don't rely on generated HTML
function setupDirectListeners() {
    // Menu buttons
    document.querySelectorAll('[id$="-btn"]').forEach(button => {
        if (button.id === 'chat-btn') {
            button.addEventListener('click', () => changeView('chat'));
        } else if (button.id === 'characters-btn') {
            button.addEventListener('click', () => changeView('characters'));
        } else if (button.id === 'settings-btn') {
            button.addEventListener('click', () => changeView('settings'));
        } else if (button.id === 'test-chat-btn') {
            button.addEventListener('click', () => forceOpenChat());
        }
    });

    // Character create button
    const createCharBtn = document.getElementById('create-character-btn');
    if (createCharBtn) {
        createCharBtn.addEventListener('click', createNewCharacter);
    }

    // Error dismiss button
    const errorContainer = document.getElementById('error-container');
    if (errorContainer) {
        errorContainer.querySelector('button').addEventListener('click', dismissError);
    }
}

// Load data from localStorage
function loadStoredData() {
    console.log("Loading stored data");

    // Load API key
    state.apiKey = getStoredItem(STORAGE_KEYS.API_KEY, "");

    // Load characters and chats
    state.characters = getStoredItem(STORAGE_KEYS.CHARACTERS, []);
    state.chats = getStoredItem(STORAGE_KEYS.CHATS, {});
    state.chatHistory = getStoredItem(STORAGE_KEYS.CHAT_HISTORY, {});
    state.lastActiveChats = getStoredItem(STORAGE_KEYS.LAST_ACTIVE_CHATS, {});

    // Clean up any invalid chat history entries
    cleanupChatHistory();

    // Load app settings
    const storedSettings = getStoredItem(STORAGE_KEYS.SETTINGS, null);
    if (storedSettings) {
        appSettings = { ...appSettings, ...storedSettings };
    }

    if (!Object.values(AI_PROVIDERS).includes(appSettings.provider)) {
        appSettings.provider = AI_PROVIDERS.GEMINI;
    }
    appSettings.modelVersion = LEGACY_GEMINI_MODEL_MAP[appSettings.modelVersion] || appSettings.modelVersion || DEFAULT_GEMINI_MODEL;
    appSettings.ollamaBaseUrl = appSettings.ollamaBaseUrl || DEFAULT_OLLAMA_URL;
    appSettings.ollamaModel = appSettings.ollamaModel || "gemma3:12b";
    appSettings.lmStudioBaseUrl = appSettings.lmStudioBaseUrl || DEFAULT_LM_STUDIO_URL;
    appSettings.lmStudioModel = appSettings.lmStudioModel || "local-model";
    delete appSettings.allowGroupChats;
    delete appSettings.topK;
    delete appSettings.topP;
    // Load personal context
    const storedContext = getStoredItem(STORAGE_KEYS.PERSONAL_CONTEXT, null);
    if (storedContext) {
        state.personalContext = { ...state.personalContext, ...storedContext };
    }

    // Set up the UI based on loaded data
    const apiKeyInput = document.getElementById('api-key-input');
    if (apiKeyInput && state.apiKey) {
        apiKeyInput.value = state.apiKey;
    }


    // Set personal context fields
    const nameInput = document.getElementById('user-name');
    const personalityInput = document.getElementById('user-personality');
    const contextInput = document.getElementById('user-context');

    if (nameInput) nameInput.value = state.personalContext.name;
    if (personalityInput) personalityInput.value = state.personalContext.personality;
    if (contextInput) contextInput.value = state.personalContext.context;

    // Update UI
    updateSidebarCharacters();
    // Initialize search and sort UI elements
    const searchInput = document.getElementById('search-characters-input');
    const sortSelect = document.getElementById('sort-characters-select');
    if (searchInput) {
        searchInput.value = state.characterSearchTerm;
    }
    if (sortSelect) {
        sortSelect.value = state.characterSortOrder;
    }

    // Check API key
    checkApiKey();
}

// Function to clean up any invalid chat history entries
function cleanupChatHistory() {
    let hasChanges = false;

    // Loop through all character history entries
    for (const historyKey in state.chatHistory) {
        if (state.chatHistory.hasOwnProperty(historyKey)) {
            // Filter out undefined or invalid entries
            const validEntries = state.chatHistory[historyKey].filter(entry =>
                entry &&
                entry.id &&
                entry.characterIds &&
                entry.characterIds.length > 0 &&
                state.chats[entry.id] // Only keep entries that have a corresponding chat
            );

            // Check if any entries were removed
            if (validEntries.length !== state.chatHistory[historyKey].length) {
                state.chatHistory[historyKey] = validEntries;
                hasChanges = true;
            }

            // Remove empty history keys
            if (state.chatHistory[historyKey].length === 0) {
                delete state.chatHistory[historyKey];
                hasChanges = true;
            }
        }
    }

    // Save changes if needed
    if (hasChanges) {
        setStoredItem(STORAGE_KEYS.CHAT_HISTORY, state.chatHistory);
        console.log("Cleaned up invalid chat history entries");
    }
}

// Set up event listeners
function setupEventListeners() {
    // Chat form submission
    const chatForm = document.getElementById('chat-form');
    const messageInput = document.getElementById('message-input');

    if (chatForm && messageInput) {
        // Handle form submission - updated to include button state update
        chatForm.addEventListener('submit', (e) => {
            e.preventDefault();
            // Call sendMessage which will update the button state
            sendMessage();
        });

        // Handle message input keydown
        messageInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                if (e.shiftKey) {
                    // Shift+Enter: insert newline
                    e.preventDefault();
                    const start = messageInput.selectionStart;
                    const end = messageInput.selectionEnd;
                    const value = messageInput.value;
                    messageInput.value = value.substring(0, start) + '\n' + value.substring(end);
                    messageInput.selectionStart = messageInput.selectionEnd = start + 1;
                } else {
                    // Just Enter: submit if not empty
                    if (messageInput.value.trim()) {
                        e.preventDefault();
                        sendMessage();
                    }
                }
            }
        });

        // Auto-resize input height based on content
        messageInput.addEventListener('input', () => {
            requestAnimationFrame(() => {
                messageInput.style.height = 'auto';
                const newScrollHeight = messageInput.scrollHeight; // Read
                messageInput.style.height = newScrollHeight + 'px'; // Write
            });
        });
    }

    // Make sidebar character items clickable
    updateSidebarCharacterListeners();

    // Save API Key button
    const saveButton = document.getElementById('save-api-key-btn');
    if (saveButton) {
        saveButton.addEventListener('click', saveApiKey);
    } else {
        // If no save button, implement API key input event listener
        const apiKeyInput = document.getElementById('api-key-input');
        if (apiKeyInput) {
            apiKeyInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    saveApiKey();
                }
            });
        }
    }

    // Handle window resize for mobile/desktop detection
    window.addEventListener('resize', debounce(() => {
        initMessageDeleteButtons();
    }, 250));

    // Setup character creation button
    const createCharacterBtn = document.getElementById('create-character-btn');
    if (createCharacterBtn) {
        createCharacterBtn.addEventListener('click', createNewCharacter);
    }

    // Setup edit character modal
    setupEditCharacterModal();

    // Setup character selection in sidebar
    updateSidebarCharacterListeners();

    // Chat history and new chat buttons
    const newChatBtn = document.getElementById('new-chat-btn');
    if (newChatBtn) {
        newChatBtn.addEventListener('click', createNewChat);
    }

    const chatHistoryBtn = document.getElementById('chat-history-btn');
    if (chatHistoryBtn) {
        chatHistoryBtn.addEventListener('click', showChatHistory);
    }

    const closeHistoryModalBtn = document.getElementById('close-history-modal-btn');
    if (closeHistoryModalBtn) {
        closeHistoryModalBtn.addEventListener('click', closeChatHistoryModal);
    }

    const closeHistoryBtn = document.getElementById('close-history-btn');
    if (closeHistoryBtn) {
        closeHistoryBtn.addEventListener('click', closeChatHistoryModal);
    }

    // Setup data export and import buttons
    const exportDataBtn = document.getElementById('export-data-btn');
    const importDataBtn = document.getElementById('import-data-btn');

    if (exportDataBtn) {
        exportDataBtn.addEventListener('click', exportAppData);
    }

    if (importDataBtn) {
        importDataBtn.addEventListener('click', importAppData);
    }

    // Setup profile picture handlers
    setupProfilePictureHandlers();

    // Setup focus handling for mobile
    setupFocusHandling();

    // Event listener for character search
    const searchInput = document.getElementById('search-characters-input');
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            state.characterSearchTerm = e.target.value;
            renderFilteredAndSortedCharacters();
        });
    }

    // Event listener for character sort
    const sortSelect = document.getElementById('sort-characters-select');
    if (sortSelect) {
        sortSelect.addEventListener('change', (e) => {
            state.characterSortOrder = e.target.value;
            renderFilteredAndSortedCharacters();
        });
    }
}

// Update sidebar character event listeners
function updateSidebarCharacterListeners() {
    console.log("Updating sidebar character listeners"); // Debug log

    // This ensures characters are clickable even if onclick attribute doesn't work
    state.characters.forEach(character => {
        const element = document.getElementById(`sidebar-char-${character.id}`);
        if (element) {
            // Remove old event listener to avoid duplicates
            const newElement = element.cloneNode(true);
            element.parentNode.replaceChild(newElement, element);

            // Add fresh event listener
            newElement.addEventListener('click', function (event) {
                event.preventDefault();
                console.log("Character clicked via event listener:", character.id);
                toggleCharacterSelection(character.id);
            });
        } else {
            console.warn(`Sidebar character element for ${character.id} not found`);
        }
    });

    // Also make sure the Start Chat button has its event listener
    // removed it
}

// View management
function changeView(viewName) {
    // Hide all views
    const views = ['chat-view', 'characters-view', 'settings-view'];
    views.forEach(view => {
        const element = document.getElementById(view);
        if (element) {
            element.classList.add('hidden');
            if (view === 'chat-view') {
                element.classList.remove('chat-active');
            }
        }
    });

    // Reset active buttons
    const buttons = ['chat-btn', 'characters-btn', 'settings-btn'];
    buttons.forEach(btn => {
        const element = document.getElementById(btn);
        if (element) {
            element.classList.remove('bg-white', 'text-primary');
            element.classList.add('text-white');
        }
    });

    // Toggle body class for fixed positioning only in chat view
    if (viewName === 'chat') {
        document.body.classList.add('chat-view-active');
    } else {
        document.body.classList.remove('chat-view-active');
    }

    // Show selected view and activate button
    if (viewName === 'chat') {
        const view = document.getElementById('chat-view');
        const btn = document.getElementById('chat-btn');
        if (view) {
            view.classList.remove('hidden');
            updateCharacterLists(); // Refresh the list when switching views

            // Add chat-active class if there's an active chat
            if (state.activeChat) {
                view.classList.add('chat-active');
            }
        }
        if (btn) {
            btn.classList.remove('text-white');
            btn.classList.add('bg-white', 'text-primary');
        }
    } else if (viewName === 'characters') {
        const view = document.getElementById('characters-view');
        const btn = document.getElementById('characters-btn');
        if (view) view.classList.remove('hidden');
        if (btn) {
            btn.classList.remove('text-white');
            btn.classList.add('bg-white', 'text-primary');
        }
    } else if (viewName === 'settings') {
        const view = document.getElementById('settings-view');
        const btn = document.getElementById('settings-btn');
        if (view) view.classList.remove('hidden');
        if (btn) {
            btn.classList.remove('text-white');
            btn.classList.add('bg-white', 'text-primary');
        }
    }
}

// Check if API key is set and working
function checkApiKey() {
    const warningElement = document.getElementById('api-warning');
    if (!warningElement) return;

    if (!isProviderConfigured() || !state.isApiConnected || state.activeProvider !== getCurrentProvider()) {
        warningElement.classList.remove('hidden');
    } else {
        warningElement.classList.add('hidden');
    }
}
// Save API key
async function saveApiKey() {
    const apiKeyInput = document.getElementById('api-key-input');
    if (apiKeyInput) {
        state.apiKey = apiKeyInput.value.trim();
        setStoredItem(STORAGE_KEYS.API_KEY, state.apiKey);
    }

    saveVisibleProviderSettings();

    const success = await initializeAIProvider();
    const savedMessage = document.getElementById('api-saved');
    if (savedMessage) {
        savedMessage.textContent = success
            ? `${getProviderDisplayName()} settings saved and connected successfully`
            : `${getProviderDisplayName()} settings saved, but the connection failed`;
        savedMessage.classList.toggle('text-green-600', success);
        savedMessage.classList.toggle('text-red-600', !success);
        savedMessage.classList.remove('hidden');
        setTimeout(() => {
            savedMessage.classList.add('hidden');
        }, 3000);
    }

    checkApiKey();
}
// Error handling
function showError(message) {
    const errorContainer = document.getElementById('error-container');
    const errorMessage = document.getElementById('error-message');

    if (errorContainer && errorMessage) {
        errorMessage.textContent = message;
        errorContainer.classList.remove('hidden');
    } else {
        console.error("Error:", message);
        alert(message); // Fallback if error container not found
    }
}

function dismissError() {
    const errorContainer = document.getElementById('error-container');
    if (errorContainer) {
        errorContainer.classList.add('hidden');
    }
}

// Character management
function createNewCharacter() {
    // Get input fields
    const nameInput = document.getElementById('character-name');
    const contextInput = document.getElementById('character-context');

    if (!nameInput || !contextInput) {
        showError("Character creation form elements not found");
        return;
    }

    const name = nameInput.value.trim();
    const context = contextInput.value.trim();

    // Better validation with more specific error messages
    if (name === '') {
        showError("Please provide a name for your character");
        nameInput.focus();
        return false;
    }

    if (context === '') {
        showError("Please provide context for your character");
        contextInput.focus();
        return false;
    }

    // Get profile picture if available
    const profilePicturePreview = document.getElementById('profile-picture-preview');
    let profilePicture = null;

    // Check if the preview has an image (not the default icon)
    if (profilePicturePreview && profilePicturePreview.querySelector('img')) {
        // Get the src attribute which contains the base64 data
        profilePicture = profilePicturePreview.querySelector('img').src;
    }

    // Create new character
    const newCharacter = {
        id: generateUniqueId(),
        name,
        userContext: context,
        enhancedContext: null,
        profilePicture: profilePicture,
        createdAt: new Date().toISOString(),
    };

    console.log("Creating new character:", newCharacter);

    // Add to state and save
    state.characters.push(newCharacter);
    setStoredItem(STORAGE_KEYS.CHARACTERS, state.characters);

    // Clear inputs AFTER validation and saving
    nameInput.value = '';
    contextInput.value = '';

    // Reset profile picture preview
    if (profilePicturePreview) {
        profilePicturePreview.innerHTML = '<i class="fas fa-user"></i>';
        profilePicturePreview.classList.remove('has-image');

        // Hide the remove button
        const removeButton = document.getElementById('remove-profile-picture');
        if (removeButton) {
            removeButton.classList.add('hidden');
        }
    }

    // Show success message
    showSuccess(`Character "${name}" created successfully!`);

    // Instead of re-rendering the entire list, append the new element:
    const characterListContainer = document.getElementById('character-list');
    if (characterListContainer) {
        // Remove "no characters" message if present
        const noChars = document.getElementById('no-characters');
        if (noChars) { noChars.remove(); }

        // Create a new div element for the character
        const newCharDiv = document.createElement('div');
        newCharDiv.id = `character-item-${newCharacter.id}`;
        newCharDiv.className = "border rounded-lg p-4 hover:shadow-md transition";

        // Determine how to display the character avatar
        let avatarHTML = '';
        if (newCharacter.profilePicture) {
            avatarHTML = `<img src="${newCharacter.profilePicture}" alt="${newCharacter.name}" class="w-10 h-10 rounded-full object-cover mr-3">`;
        } else {
            avatarHTML = `<div class="character-avatar bg-primary/20 text-primary mr-3">${newCharacter.name.charAt(0).toUpperCase()}</div>`;
        }

        newCharDiv.innerHTML = `
            <div class="flex justify-between items-start">
                <div class="flex items-center">
                    ${avatarHTML}
                    <h3 class="font-bold text-lg">${newCharacter.name}</h3>
                </div>
                <div class="flex space-x-2">
                    <button id="edit-btn-${newCharacter.id}" class="text-blue-500 hover:text-blue-700" title="Edit character">
                        <i class="fas fa-edit"></i>
                    </button>
                    <button id="delete-btn-${newCharacter.id}" class="text-red-500 hover:text-red-700" title="Delete character">
                        <i class="fas fa-trash"></i>
                    </button>
                </div>
            </div>

            <div class="mt-2">
                <p class="text-sm text-gray-700 font-semibold">User-Provided Context:</p>
                <div class="text-gray-600 text-sm mt-1 max-h-32 overflow-auto p-1 border rounded bg-gray-50">
                    ${newCharacter.userContext}
                </div>
            </div>

            ${newCharacter.enhancedContext ? `
            <div class="mt-3 bg-gray-50 p-2 rounded enhanced-context" id="enhanced-context-${newCharacter.id}">
                <p class="text-sm text-gray-700 font-semibold">Enhanced Context:</p>
                <div class="text-gray-600 text-sm mt-1 max-h-60 overflow-auto p-1 border rounded bg-white">
                    ${newCharacter.enhancedContext}
                </div>
            </div>
            ` : ''}

            <div class="mt-3 flex justify-center">
                <button id="enhance-btn-${newCharacter.id}" class="text-sm bg-secondary text-white px-3 py-1 rounded hover:bg-secondary/90 transition ${!isProviderConfigured() ? 'disabled:bg-gray-400' : ''}" ${!isProviderConfigured() ? 'disabled' : ''}>
                    <i class="fas fa-magic mr-1"></i> ${newCharacter.enhancedContext ? 'Re-Enhance Context' : 'Enhance Context'}
                </button>
            </div>
        `;

        // Append the new character element to the container
        characterListContainer.appendChild(newCharDiv);

        // Set up event listeners for the new element:
        const editBtn = newCharDiv.querySelector(`#edit-btn-${newCharacter.id}`);
        if (editBtn) {
            editBtn.addEventListener('click', (e) => {
                e.preventDefault();
                editCharacter(newCharacter.id);
            });
        }

        const deleteBtn = newCharDiv.querySelector(`#delete-btn-${newCharacter.id}`);
        if (deleteBtn) {
            deleteBtn.addEventListener('click', (e) => {
                e.preventDefault();
                deleteCharacter(newCharacter.id);
            });
        }

        const enhanceBtn = newCharDiv.querySelector(`#enhance-btn-${newCharacter.id}`);
        if (enhanceBtn) {
            enhanceBtn.addEventListener('click', (e) => {
                e.preventDefault();
                enhanceCharacterContext(newCharacter.id);
            });
        }
    }

    // Also update the sidebar if needed
    updateSidebarCharacters();

    // Full UI update
    updateCharacterLists();
    window.scrollTo(0, document.body.scrollHeight); // scroll to bottom to see new character

    // If the characters view is currently hidden, switch to it
    if (document.getElementById('characters-view').classList.contains('hidden')) {
        changeView('characters');
    }
    return true;
}

// Helper function to set up event listeners for character items
function setupCharacterItemListeners() {
    // Set up enhance button event listeners
    document.querySelectorAll('[id^="enhance-btn-"]').forEach(button => {
        const characterId = button.id.replace('enhance-btn-', '');

        // Remove existing event listeners by cloning and replacing
        const newButton = button.cloneNode(true);
        button.parentNode.replaceChild(newButton, button);

        newButton.addEventListener('click', (e) => {
            e.preventDefault();
            enhanceCharacterContext(characterId);
        });
    });

    // Set up edit button event listeners
    document.querySelectorAll('[id^="edit-btn-"]').forEach(button => {
        const characterId = button.id.replace('edit-btn-', '');

        // Remove existing event listeners by cloning and replacing
        const newButton = button.cloneNode(true);
        button.parentNode.replaceChild(newButton, button);

        newButton.addEventListener('click', (e) => {
            e.preventDefault();
            editCharacter(characterId);
        });
    });

    // Set up delete button event listeners
    document.querySelectorAll('[id^="delete-btn-"]').forEach(button => {
        const characterId = button.id.replace('delete-btn-', '');

        // Remove existing event listeners by cloning and replacing
        const newButton = button.cloneNode(true);
        button.parentNode.replaceChild(newButton, button);

        newButton.addEventListener('click', (e) => {
            e.preventDefault();
            deleteCharacter(characterId);
        });
    });
}

// Function to generate HTML for character list
function generateCharacterListHTML() {
    return state.characters.map(character => {
        // Determine how to display the character avatar
        let avatarHTML = '';
        if (character.profilePicture) {
            avatarHTML = `<img src="${character.profilePicture}" alt="${character.name}" class="w-10 h-10 rounded-full object-cover mr-3">`;
        } else {
            avatarHTML = `<div class="character-avatar bg-primary/20 text-primary mr-3">${character.name.charAt(0).toUpperCase()}</div>`;
        }

        return `
        <div class="border rounded-lg p-4 hover:shadow-md transition" id="character-item-${character.id}">
                <div class="flex justify-between items-start">
                    <div class="flex items-center">
                        ${avatarHTML}
                        <h3 class="font-bold text-lg">${character.name}</h3>
                    </div>
                    <div class="flex space-x-2">
                        <button
                            id="edit-btn-${character.id}"
                            class="text-blue-500 hover:text-blue-700"
                            title="Edit character"
                        >
                            <i class="fas fa-edit"></i>
                        </button>
                        <button
                            id="delete-btn-${character.id}"
                            class="text-red-500 hover:text-red-700"
                            title="Delete character"
                        >
                            <i class="fas fa-trash"></i>
                        </button>
                    </div>
                </div>
                
                <div class="mt-2">
                    <p class="text-sm text-gray-700 font-semibold">User-Provided Context:</p>
                    <div class="text-gray-600 text-sm mt-1 max-h-32 overflow-auto p-1 border rounded bg-gray-50">
                        ${character.userContext}
                    </div>
                </div>
                
                ${character.enhancedContext ? `
                <div class="mt-3 bg-gray-50 p-2 rounded enhanced-context" id="enhanced-context-${character.id}">
                        <p class="text-sm text-gray-700 font-semibold">Enhanced Context:</p>
                        <div class="text-gray-600 text-sm mt-1 max-h-60 overflow-auto p-1 border rounded bg-white">
                            ${character.enhancedContext}
                        </div>
                    </div>
                ` : ''}
                
                <div class="mt-3 flex justify-center">
                    <button
                        id="enhance-btn-${character.id}"
                        class="text-sm bg-secondary text-white px-3 py-1 rounded hover:bg-secondary/90 transition disabled:bg-gray-400"
                    ${!isProviderConfigured() ? 'disabled' : ''}
                    >
                    <i class="fas fa-magic mr-1"></i> ${character.enhancedContext ? 'Re-Enhance Context' : 'Enhance Context'}
                    </button>
                </div>
            </div>
        `;
    }).join('');
}

// Function to update just the sidebar character list
function updateSidebarCharacters() {
    console.log("Updating sidebar characters list");
    const sidebarCharactersContainer = document.getElementById('sidebar-characters');

    if (!sidebarCharactersContainer) {
        console.error("Sidebar characters container not found");
        return;
    }

    try {
        if (state.characters.length === 0) {
            sidebarCharactersContainer.innerHTML = `
                <p class="text-gray-500 italic p-4 text-sm">
                    No characters created yet. Go to Characters tab to create some.
                </p>
            `;
        } else {
            // Sort characters by most recent chat
            const sortedCharacters = [...state.characters].sort((a, b) => {
                const aIsActive = state.activeCharacters && state.activeCharacters.some(c => c.id === a.id);
                const bIsActive = state.activeCharacters && state.activeCharacters.some(c => c.id === b.id);

                // Active characters always come first
                if (aIsActive && !bIsActive) return -1;
                if (!aIsActive && bIsActive) return 1;

                const aTimestamp = getLastMessageTimestamp(a.id);
                const bTimestamp = getLastMessageTimestamp(b.id);

                // Ensure createdAt is valid, default to 0 if not (for very old data potentially)
                const aCreationTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
                const bCreationTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;

                // Rule 1: If one character has chats (timestamp > 0) and the other doesn't (timestamp == 0),
                // the one without chats (potentially newer) comes first (return -1 for a, 1 for b).
                if (aTimestamp === 0 && bTimestamp !== 0) return -1;
                if (aTimestamp !== 0 && bTimestamp === 0) return 1;

                // Rule 2: If both characters have no chats (both timestamps are 0),
                // sort by most recent creation time (descending order, so newer characters first).
                if (aTimestamp === 0 && bTimestamp === 0) {
                    return bCreationTime - aCreationTime;
                }

                // Rule 3: If both characters have chats (both timestamps > 0),
                // sort by most recent message timestamp (descending order).
                return bTimestamp - aTimestamp;
            });

            const sidebarHTML = sortedCharacters.map(character => {
                const lastMessageTime = getLastMessageTimestamp(character.id);
                const hasRecentChat = lastMessageTime > 0;
                const isActive = state.activeCharacters && state.activeCharacters.some(c => c.id === character.id);

                // Format date with time
                const formatDateTime = (timestamp) => {
                    const date = new Date(timestamp);
                    return date.toLocaleString(undefined, {
                        month: '2-digit',
                        day: '2-digit',
                        year: 'numeric',
                        hour: 'numeric',
                        minute: '2-digit',
                        hour12: true
                    });
                };

                // Determine how to display the character avatar
                let avatarHTML = '';
                let avatarClass = '';
                if (character.profilePicture) {
                    avatarHTML = `<img src="${character.profilePicture}" alt="${character.name}" class="w-full h-full object-cover">`;
                    avatarClass = 'has-image';
                } else {
                    avatarHTML = character.name.charAt(0).toUpperCase();
                    avatarClass = '';
                }

                return `
                <div 
                    id="sidebar-char-${character.id}"
                    data-character-id="${character.id}"
                    class="p-3 rounded mb-2 cursor-pointer character-item ${state.selectedCharacters.includes(character.id)
                        ? 'bg-primary/10 border-primary/30 border'
                        : 'hover:bg-gray-100 border border-transparent'
                    } ${isActive ? 'border-primary' : ''}"
                >
                    <div class="flex items-center justify-between">
                        <div class="flex items-center">
                            <div class="character-avatar bg-primary/20 text-primary ${avatarClass}">
                                ${avatarHTML}
                            </div>
                            <div class="ml-2 overflow-hidden">
                                <p class="font-medium truncate">${character.name}</p>
                                ${hasRecentChat ? `
                                <p class="text-xs text-gray-500">
                                    Last chat: ${isActive ? 'Active now' : formatDateTime(lastMessageTime)}
                                </p>` : ''}
                            </div>
                        </div>
                        
                        <div class="w-2 h-2 rounded-full ${isActive ? 'bg-primary' : 'bg-primary/50'}"></div>
                    </div>
                </div>
            `}).join('');

            // Use innerHTML for the sidebar update
            sidebarCharactersContainer.innerHTML = sidebarHTML;
        }

        // Setup event listeners for the sidebar characters
        setupSidebarCharacterListeners();

    } catch (error) {
        console.error("Error updating sidebar characters:", error);
    }
}

// Function to setup sidebar character listeners
function setupSidebarCharacterListeners() {
    console.log("Setting up sidebar character listeners");

    document.querySelectorAll('[id^="sidebar-char-"]').forEach(element => {
        const characterId = element.getAttribute('data-character-id');
        if (!characterId) {
            console.warn("Character element without data-character-id:", element);
            return;
        }

        // Remove any existing event listeners by cloning and replacing
        const newElement = element.cloneNode(true);
        element.parentNode.replaceChild(newElement, element);

        // Add fresh event listener using the data attribute
        newElement.addEventListener('click', function (e) {
            e.preventDefault();
            console.log("Character clicked in sidebar:", characterId);
            toggleCharacterSelection(characterId);
        });
    });

    // Also set up the Start Chat button
    // removed it
}

// Character selection in sidebar
function toggleCharacterSelection(characterId) {
    console.log("Character selected:", characterId);

    // Check if character exists
    const character = state.characters.find(c => c.id === characterId);
    if (!character) {
        console.error("Character not found:", characterId);
        return;
    }

    // Check if this character is already selected
    const wasSelected = state.selectedCharacters.includes(characterId);

    // Save the previous active chat to clean up in-progress system messages
    const previousActiveChat = state.activeChat;

    // Single-character mode is enforced. Selecting a character replaces the current chat target.
    state.selectedCharacters = [characterId];

    // Update UI to reflect selection state
    updateSidebarCharacters();

    // Close the sidebar on mobile after character selection
    if (window.innerWidth <= 768) {
        const sidebar = document.getElementById('character-sidebar');
        const overlay = document.querySelector('.sidebar-overlay');
        if (sidebar && sidebar.classList.contains('sidebar-open')) {
            sidebar.classList.remove('sidebar-open');
            // No need to manage overlay on mobile as it's hidden via CSS
        }
    }

    // If we're removing a character from an active chat
    if (wasSelected && state.selectedCharacters.length === 0) {
        // Show placeholder, hide chat
        const chatWindow = document.getElementById('chat-window');
        const placeholder = document.getElementById('chat-placeholder');

        if (chatWindow) { chatWindow.classList.add('hidden'); }
        if (placeholder) { placeholder.classList.remove('hidden'); }

        // Force a layout refresh
        setTimeout(() => {
            window.dispatchEvent(new Event('resize'));
        }, 10);
    }

    // Clean up any completed pending responses 
    cleanupPendingResponses();

    // Clean up any "continuing conversation" system messages in the previous chat
    if (previousActiveChat && state.chats[previousActiveChat]) {
        const messages = state.chats[previousActiveChat];
        let hasChanges = false;

        // Look for system messages with "..." content (the continue indicator)
        messages.forEach(msg => {
            if (msg.isSystem && msg.content === "..." && !msg.isDeleted) {
                msg.isDeleted = true;
                hasChanges = true;
            }
        });

        // Save changes if needed
        if (hasChanges) {
            setStoredItem(STORAGE_KEYS.CHATS, state.chats);
        }
    }

    // Auto-start chat in single character mode
    if (state.selectedCharacters.length === 1) {
        console.log("Auto-starting chat since character was selected");

        // Ensure the character's chat reference is maintained
        ensureCharacterChatReference(characterId);

        // Check if there's a last active chat for this character
        const lastChatId = state.lastActiveChats[characterId];

        if (lastChatId && state.chats[lastChatId]) {
            console.log("Resuming last active chat:", lastChatId);

            // Set as active chat
            state.activeChat = lastChatId;

            // Update active characters
            state.activeCharacters = state.characters.filter(c => state.selectedCharacters.includes(c.id)).slice(0, 1);

            // Ensure the chat has at least one message (add a welcome message if empty)
            if (state.chats[lastChatId].length === 0) {
                const welcomeMsg = {
                    id: generateUniqueId(),
                    content: `Starting conversation with ${state.activeCharacters.map(c => c.name).join(', ')}.`,
                    isUser: false,
                    isSystem: true,
                    timestamp: new Date().toISOString(),
                    isDeleted: false
                };

                state.chats[lastChatId].push(welcomeMsg);
                setStoredItem(STORAGE_KEYS.CHATS, state.chats);
            }

            // Update UI
            changeView('chat');
            updateChatUI();
        } else {
            // Start a new chat if no last active chat exists
            startChat();
        }
    }
}

// Chat functionality
function startChat() {
    console.log("Start chat clicked", state.selectedCharacters); // Debug log

    if (state.selectedCharacters.length === 0) {
        showError("Please select a character to chat with");
        return;
    }

    if (state.selectedCharacters.length > 1) {
        state.selectedCharacters = [state.selectedCharacters[0]];
    }

    // Clean up any existing chat's system messages before changing
    if (state.activeChat && state.chats[state.activeChat]) {
        const messages = state.chats[state.activeChat];
        let hasChanges = false;

        // Look for system messages with "..." content (the continue indicator)
        messages.forEach(msg => {
            if (msg.isSystem && msg.content === "..." && !msg.isDeleted) {
                msg.isDeleted = true;
                hasChanges = true;
            }
        });

        // Save changes if needed
        if (hasChanges) {
            setStoredItem(STORAGE_KEYS.CHATS, state.chats);
        }
    }

    // Generate chat ID
    const chatId = [...state.selectedCharacters].sort().join('-');
    state.activeChat = chatId;

    // Ensure chat exists in state
    if (!state.chats[chatId]) {
        state.chats[chatId] = [];
        setStoredItem(STORAGE_KEYS.CHATS, state.chats);
    }

    // Update active characters
    state.activeCharacters = state.characters.filter(c => state.selectedCharacters.includes(c.id)).slice(0, 1);

    // Save the active chat ID for each selected character
    state.selectedCharacters.forEach(characterId => {
        state.lastActiveChats[characterId] = chatId;
    });
    setStoredItem(STORAGE_KEYS.LAST_ACTIVE_CHATS, state.lastActiveChats);

    // Create a welcome message for the chat if it's empty
    if (state.chats[chatId].length === 0) {
        // Add greeting message to the chat
        const welcomeMsg = {
            id: generateUniqueId(),
            content: `New conversation started with ${state.activeCharacters.map(c => c.name).join(', ')}`,
            isUser: false,
            isSystem: true,
            timestamp: new Date().toISOString(),
            isDeleted: false
        };

        // Add welcome message to the chat
        state.chats[chatId].push(welcomeMsg);
        setStoredItem(STORAGE_KEYS.CHATS, state.chats);

        // For new conversations, let the character initialize with a greeting
        // But only do this if we're connected to the API
        if (state.isApiConnected && state.activeCharacters.length === 1) {
            // Update UI first
            changeView('chat');
            updateChatUI();

            // Wait a moment for UI to update before triggering greeting
            setTimeout(() => {
                const character = state.activeCharacters[0];

                // Create a special init message that won't be displayed
                const initMsg = {
                    id: generateUniqueId(),
                    content: "Hello",
                    isUser: true,
                    timestamp: new Date().toISOString(),
                    isDeleted: true, // Won't be shown in UI
                    isInitializing: true // Special flag for first-time greeting
                };

                // Generate character's greeting (async)
                getCharacterResponse(character, initMsg);
            }, 500);
        }
    } else {
        // Also clean up any continue messages in this chat
        const messages = state.chats[chatId];
        let hasChanges = false;

        messages.forEach(msg => {
            if (msg.isSystem && msg.content === "..." && !msg.isDeleted) {
                msg.isDeleted = true;
                hasChanges = true;
            }
        });

        // Save changes if needed
        if (hasChanges) {
            setStoredItem(STORAGE_KEYS.CHATS, state.chats);
        }
    }

    // Update UI - Make sure to switch to chat view first
    changeView('chat');
    updateChatUI();

    // Update sidebar to show the most recent characters at the top
    updateSidebarCharacters();
}

// Helper function to ensure that chat references are maintained when a chat is cleared
function ensureCharacterChatReference(characterId) {
    // Check if the character exists
    const character = state.characters.find(c => c.id === characterId);
    if (!character) return false;

    // Check if there's a last active chat for this character
    const lastChatId = state.lastActiveChats[characterId];

    // If no lastChatId or no chat data exists for it, create a new chat
    if (!lastChatId || !state.chats[lastChatId]) {
        const newChatId = characterId;
        state.lastActiveChats[characterId] = newChatId;
        state.chats[newChatId] = [];

        // Add welcome message
        const welcomeMsg = {
            id: generateUniqueId(),
            content: `New conversation started with ${character.name}.`,
            isUser: false,
            isSystem: true,
            timestamp: new Date().toISOString(),
            isDeleted: false
        };

        state.chats[newChatId].push(welcomeMsg);

        // Save to storage
        setStoredItem(STORAGE_KEYS.CHATS, state.chats);
        setStoredItem(STORAGE_KEYS.LAST_ACTIVE_CHATS, state.lastActiveChats);

        return true;
    }

    return true;
}

// Update the updateChatUI function to check for completed responses
function updateChatUI() {
    console.log("Updating chat UI"); // Debug log

    // Hide placeholder, show chat window
    const placeholder = document.getElementById('chat-placeholder');
    const chatWindow = document.getElementById('chat-window');

    if (placeholder) placeholder.classList.add('hidden');
    if (chatWindow) chatWindow.classList.remove('hidden');

    // Update chat header
    const characterNames = state.activeCharacters.map(c => c.name).join(', ');
    const headerTitle = document.getElementById('chat-header-title');
    if (headerTitle) headerTitle.textContent = characterNames;

    // Update chat header with profile pictures
    const chatHeaderAvatars = document.getElementById('chat-header-avatars');
    if (chatHeaderAvatars) {
        // Clear existing avatars
        chatHeaderAvatars.innerHTML = '';

        // Add avatars for each active character
        state.activeCharacters.forEach(character => {
            const avatarElement = document.createElement('div');
            avatarElement.className = 'character-avatar bg-primary/20 text-primary mr-2';

            if (character.profilePicture) {
                avatarElement.innerHTML = `<img src="${character.profilePicture}" alt="${character.name}" class="w-full h-full object-cover">`;
                avatarElement.classList.add('has-image');
            } else {
                avatarElement.textContent = character.name.charAt(0).toUpperCase();
            }

            chatHeaderAvatars.appendChild(avatarElement);
        });
    }

    // Check for completed responses for the active characters
    if (state.activeCharacters.length > 0 && state.activeChat) {
        state.activeCharacters.forEach(character => {
            if (state.pendingResponses[character.id]) {
                const pendingData = state.pendingResponses[character.id];

                // If the pending response is for this chat but generation is complete
                if (pendingData.chatId === state.activeChat && !pendingData.isGenerating) {
                    // Clean up this entry since we're displaying it now
                    delete state.pendingResponses[character.id];
                }
            }
        });
    }

    // Update messages
    updateChatMessages(); // This function populates the messages

    const messagesContainer = document.getElementById('chat-messages');
    if (messagesContainer) {
        requestAnimationFrame(() => { // Defer scroll to next frame
            messagesContainer.scrollTop = messagesContainer.scrollHeight;
        });
    }
}

function updateChatMessages() {
    if (!state.activeChat) return;

    const messagesContainer = document.getElementById('chat-messages');
    if (!messagesContainer) return;

    const messages = state.chats[state.activeChat] || [];

    // Filter out deleted messages
    const visibleMessages = messages.filter(message => !message.isDeleted);

    if (visibleMessages.length === 0) {
        messagesContainer.innerHTML = `
            <div class="text-center text-gray-500 mt-8">
                <p>No messages yet. Start the conversation!</p>
            </div>
        `;

        // Make sure the chat window is visible even if empty
        const chatWindow = document.getElementById('chat-window');
        const placeholder = document.getElementById('chat-placeholder');

        if (chatWindow) chatWindow.classList.remove('hidden');
        if (placeholder) placeholder.classList.add('hidden');
    } else {
        // Clear the container before adding new elements
        messagesContainer.innerHTML = '';
        visibleMessages.forEach(message => {
            const messageElement = createMessageHTML(message);
            if (messageElement) { // Ensure messageElement is not null
                messagesContainer.appendChild(messageElement);
            }
        });
    }

    // Scroll to bottom
    messagesContainer.scrollTop = messagesContainer.scrollHeight;

    // Initialize delete buttons based on device type
    initMessageDeleteButtons();
}

function createMessageHTML(message) {
    const mainDiv = document.createElement('div');
    mainDiv.setAttribute('data-message-id', message.id);
    mainDiv.onmouseenter = () => showMessageActions(message.id);
    mainDiv.onmouseleave = () => hideMessageActions(message.id);

    // Helper to create elements with classes
    const createElement = (tag, classes = [], attributes = {}) => {
        const el = document.createElement(tag);
        if (classes.length > 0) el.className = classes.join(' ');
        for (const attr in attributes) {
            el.setAttribute(attr, attributes[attr]);
        }
        return el;
    };

    // processContent function is now defined outside createMessageHTML

    if (message.isTyping) {
        const character = state.characters.find(c => c.id === message.characterId) || { name: 'Unknown', profilePicture: null };
        mainDiv.className = 'flex justify-start w-full';

        const avatarDiv = createElement('div', ['character-avatar', 'bg-primary/20', 'text-primary', 'self-end', 'mb-1', 'mr-1']);
        if (character.profilePicture) {
            avatarDiv.classList.add('has-image');
            const img = createElement('img', ['w-full', 'h-full', 'object-cover'], { src: character.profilePicture, alt: character.name });
            avatarDiv.appendChild(img);
        } else {
            avatarDiv.textContent = character.name.charAt(0).toUpperCase();
        }
        mainDiv.appendChild(avatarDiv);

        const messageContainer = createElement('div', ['message-container-character']);
        const charNameDiv = createElement('div', ['text-xs', 'text-gray-600', 'ml-2', 'mb-1']);
        charNameDiv.textContent = character.name;
        messageContainer.appendChild(charNameDiv);

        const bubbleDiv = createElement('div', ['message-bubble', 'character-message', 'typing-indicator-bubble']);
        const statusDiv = createElement('div', ['typing-status-text']);
        statusDiv.textContent = message.content || `${character.name} is thinking...`;
        const typingIndicator = createElement('div', ['typing-indicator']);
        typingIndicator.setAttribute('aria-label', statusDiv.textContent);
        typingIndicator.innerHTML = '<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>';
        bubbleDiv.appendChild(statusDiv);
        bubbleDiv.appendChild(typingIndicator);
        const deleteButton = createElement('button', ['absolute', '-top-3', '-right-3', 'bg-red-500', 'text-white', 'rounded-full', 'w-6', 'h-6', 'flex', 'items-center', 'justify-center', 'shadow', 'hover:bg-red-600', 'transition', 'hidden'], { id: `delete-msg-${message.id}`, title: "Remove stuck typing indicator" });
        deleteButton.innerHTML = '<i class="fas fa-times text-xs"></i>';
        deleteButton.onclick = () => deleteMessage(message.id);
        bubbleDiv.appendChild(deleteButton);

        messageContainer.appendChild(bubbleDiv);
        mainDiv.appendChild(messageContainer);
        return mainDiv;
    }

    if (message.isSystem) {
        mainDiv.className = 'flex justify-center my-4';
        if (message.content === "...") {
            mainDiv.classList.remove('my-4');
            mainDiv.classList.add('my-2');
            const indicatorDiv = createElement('div', ['system-continue-indicator']);
            indicatorDiv.innerHTML = '<i class="fas fa-ellipsis-h mr-1"></i> Continuing conversation...';
            mainDiv.appendChild(indicatorDiv);
        } else {
            const systemBubble = createElement('div', ['bg-gray-100', 'text-gray-600', 'px-4', 'py-2', 'rounded-full', 'text-sm']);
            systemBubble.textContent = message.content; // System messages are plain text
            mainDiv.appendChild(systemBubble);
        }
        return mainDiv;
    }

    const messageContainerOuter = createElement('div'); // This will be mainDiv for user/char messages
    const messageContainerInner = createElement('div'); // For bubble and timestamp/buttons

    const bubbleDiv = createElement('div', ['message-bubble']);
    // Create a specific element for the textual content
    const textContentDiv = createElement('div', ['message-text-content']);
    textContentDiv.innerHTML = processContent(message.content); // Processed content goes into textContentDiv
    bubbleDiv.appendChild(textContentDiv);

    const deleteButton = createElement('button', ['absolute', '-top-3', '-right-3', 'bg-red-500', 'text-white', 'rounded-full', 'w-6', 'h-6', 'flex', 'items-center', 'justify-center', 'shadow', 'hover:bg-red-600', 'transition', 'hidden'], { id: `delete-msg-${message.id}` });
    deleteButton.innerHTML = '<i class="fas fa-times text-xs"></i>';
    deleteButton.onclick = () => deleteMessage(message.id);
    bubbleDiv.appendChild(deleteButton); // Delete button is a sibling of textContentDiv
    messageContainerInner.appendChild(bubbleDiv);

    const controlsDiv = createElement('div', ['flex', 'items-center']);
    const timestampDiv = createElement('div', ['text-xs', 'text-gray-500', 'mt-1']);
    const timestampSpan = createElement('span');
    if (message.edited) {
        const editedSpan = createElement('span', ['text-xs', 'italic', 'mr-1']);
        editedSpan.textContent = 'edited';
        timestampSpan.appendChild(editedSpan);
    }
    timestampSpan.appendChild(document.createTextNode(new Date(message.timestamp).toLocaleString([], { month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })));
    timestampDiv.appendChild(timestampSpan);


    if (message.isUser) {
        mainDiv.className = 'flex justify-end w-full';
        messageContainerInner.classList.add('message-container-user');
        bubbleDiv.classList.add('user-message');
        controlsDiv.classList.add('justify-end');
        timestampDiv.classList.add('mr-2');

        const isLastUserMessage = (() => {
            if (!state.activeChat) return false;
            const messages = state.chats[state.activeChat] || [];
            const userMessages = messages.filter(m => m.isUser && !m.isDeleted && !m.isContinue);
            return userMessages.length > 0 && userMessages[userMessages.length - 1].id === message.id;
        })();

        if (isLastUserMessage) {
            const editButton = createElement('button', ['ml-2', 'text-primary', 'hover:text-primary/70', 'edit-msg-btn'], { title: "Edit message" });
            editButton.innerHTML = '<i class="fas fa-pencil-alt text-xs"></i>';
            editButton.onclick = () => editMessage(message.id);
            timestampDiv.appendChild(editButton);
        }
    } else { // Character message
        const character = state.characters.find(c => c.id === message.characterId) || { name: 'Unknown', profilePicture: null };
        mainDiv.className = 'flex justify-start w-full';

        const avatarDiv = createElement('div', ['character-avatar', 'bg-primary/20', 'text-primary', 'self-end', 'mb-1', 'mr-1']);
        if (character.profilePicture) {
            avatarDiv.classList.add('has-image');
            const img = createElement('img', ['w-full', 'h-full', 'object-cover'], { src: character.profilePicture, alt: character.name });
            avatarDiv.appendChild(img);
        } else {
            avatarDiv.textContent = character.name.charAt(0).toUpperCase();
        }
        mainDiv.appendChild(avatarDiv);

        messageContainerInner.classList.add('message-container-character');
        const charNameDiv = createElement('div', ['text-xs', 'text-gray-600', 'ml-2', 'mb-1']);
        charNameDiv.textContent = character.name;
        messageContainerInner.insertBefore(charNameDiv, bubbleDiv); // Insert name before bubble

        bubbleDiv.classList.add('character-message');
        timestampDiv.classList.add('ml-2');


        const isLastCharacterMessage = (() => {
            if (!state.activeChat) return false;
            const messages = state.chats[state.activeChat] || [];
            const characterMessages = messages.filter(m => !m.isUser && m.characterId === message.characterId && !m.isDeleted && !m.isTyping);
            return characterMessages.length > 0 && characterMessages[characterMessages.length - 1].id === message.id;
        })();

        const isFollowedByUserMessage = (() => {
            if (!state.activeChat) return false;
            const messages = state.chats[state.activeChat] || [];
            const messageIndex = messages.findIndex(m => m.id === message.id);
            for (let i = messageIndex + 1; i < messages.length; i++) {
                if (messages[i].isUser && !messages[i].isDeleted) return true;
            }
            return false;
        })();

        const showRegenerateButton = isLastCharacterMessage && !isFollowedByUserMessage && !state.isResponseInProgress;

        if (showRegenerateButton) {
            const regenerateButton = createElement('button', ['ml-4', 'text-primary', 'hover:text-primary/70', 'edit-msg-btn'], { title: "Regenerate response" });
            regenerateButton.innerHTML = '<i class="fas fa-redo-alt text-xs"></i> <span class="text-xs">Regenerate</span>';
            regenerateButton.onclick = () => regenerateMessage(message.characterId);
            timestampDiv.appendChild(regenerateButton);
        }

        if (isLastCharacterMessage && !state.isResponseInProgress) {
            const editButton = createElement('button', ['ml-4', 'text-primary', 'hover:text-primary/70', 'edit-msg-btn'], { title: "Edit message" });
            editButton.innerHTML = '<i class="fas fa-pencil-alt text-xs"></i> <span class="text-xs">Edit</span>';
            editButton.onclick = () => editMessage(message.id);
            timestampDiv.appendChild(editButton);
        }
    }

    controlsDiv.appendChild(timestampDiv);
    messageContainerInner.appendChild(controlsDiv);
    mainDiv.appendChild(messageContainerInner);

    return mainDiv;
}

// Message action buttons
function showMessageActions(messageId) {
    // Only show/hide on desktop - on mobile they're always visible via CSS
    if (window.innerWidth > 768) {
        const deleteButton = document.getElementById(`delete-msg-${messageId}`);
        if (deleteButton) {
            deleteButton.classList.remove('hidden');
        }

        // Also show edit button with higher opacity
        const messageElement = document.querySelector(`[data-message-id="${messageId}"]`);
        if (messageElement) {
            const editButton = messageElement.querySelector('.edit-msg-btn');
            if (editButton) {
                editButton.style.opacity = '1';
            }
        }
    }
}

function hideMessageActions(messageId) {
    // Only show/hide on desktop - on mobile they're always visible via CSS
    if (window.innerWidth > 768) {
        const deleteButton = document.getElementById(`delete-msg-${messageId}`);
        if (deleteButton) {
            deleteButton.classList.add('hidden');
        }

        // Reduce opacity of edit button
        const messageElement = document.querySelector(`[data-message-id="${messageId}"]`);
        if (messageElement) {
            const editButton = messageElement.querySelector('.edit-msg-btn');
            if (editButton) {
                editButton.style.opacity = '0.7';
            }
        }
    }
}

function deleteMessage(messageId) {
    if (!state.activeChat) return;

    // Get the messages array
    const messages = state.chats[state.activeChat];
    const messageIndex = messages.findIndex(m => m.id === messageId);

    if (messageIndex !== -1) {
        const message = messages[messageIndex];

        // If it's a typing indicator, remove it completely instead of marking as deleted
        if (message.isTyping) {
            // First find and remove any related continue system messages
            // These typically appear right before the typing indicator
            let continueMessageIndex = -1;

            // Look for the continue system message that might be before this typing indicator
            for (let i = messageIndex - 1; i >= 0; i--) {
                const prevMsg = messages[i];
                if (prevMsg.isSystem && prevMsg.content === "...") {
                    continueMessageIndex = i;
                    break;
                }
                // Stop looking if we hit a non-system message
                if (!prevMsg.isSystem) {
                    break;
                }
            }

            // Remove messages in reverse order to avoid index issues
            if (continueMessageIndex !== -1) {
                // Remove the continue system message first
                messages.splice(continueMessageIndex, 1);
                // Now remove the typing indicator (its index has shifted down by 1)
                messages.splice(messageIndex - 1, 1);
            } else {
                // Just remove the typing indicator
                messages.splice(messageIndex, 1);
            }

            showSuccess("Typing indicator removed", 2000);
        } else {
            // Mark regular message as deleted
            messages[messageIndex].isDeleted = true;
        }

        // Save changes
        setStoredItem(STORAGE_KEYS.CHATS, state.chats);

        // Update UI
        updateChatMessages();
    }
}

// Start message editing mode
function editMessage(messageId) {
    if (!state.activeChat) return;

    // Get message element and validate ID
    const messages = state.chats[state.activeChat];
    const messageIndex = messages.findIndex(m => m.id === messageId);

    if (messageIndex === -1) return;

    const message = messages[messageIndex];
    const messageElement = document.querySelector(`[data-message-id="${messageId}"]`);
    if (!messageElement) return;

    // Check if this is a user message - if so, only allow editing the most recent user message
    if (message.isUser) {
        const userMessages = messages.filter(m => m.isUser && !m.isDeleted && !m.isContinue);
        const isLastUserMessage = userMessages.length > 0 &&
            userMessages[userMessages.length - 1].id === messageId;

        if (!isLastUserMessage) {
            showError("You can only edit your most recent message");
            return;
        }
    } else {
        // For character messages, only allow editing the most recent message from that character
        const characterMessages = messages.filter(m =>
            !m.isUser &&
            m.characterId === message.characterId &&
            !m.isDeleted &&
            !m.isTyping
        );

        const isLastCharacterMessage = characterMessages.length > 0 &&
            characterMessages[characterMessages.length - 1].id === messageId;

        if (!isLastCharacterMessage) {
            showError("You can only edit the most recent message from this character");
            return;
        }
    }

    // Find the message content container
    const contentContainer = messageElement.querySelector('.message-bubble');
    if (!contentContainer) return;

    // Store original content in case user cancels
    contentContainer.setAttribute('data-original-content', contentContainer.innerHTML);

    // Create and set up the textarea
    const textarea = document.createElement('textarea');
    textarea.className = 'edit-message-textarea p-3 border rounded resize min-w-[300px] min-h-[150px]';
    textarea.style.width = '100%';
    textarea.style.maxWidth = '600px'; // Maximum width
    textarea.style.fontSize = '1rem';
    textarea.value = message.content; // Raw content for editing

    // Create save button
    const saveButton = document.createElement('button');
    saveButton.className = 'edit-save-btn bg-primary text-white px-4 py-2 rounded mt-2 text-sm';
    saveButton.innerHTML = '<i class="fas fa-check mr-1"></i> Save';
    saveButton.onclick = () => saveEditedMessage(messageId, textarea.value);

    // Create cancel button
    const cancelButton = document.createElement('button');
    cancelButton.className = 'edit-cancel-btn bg-gray-400 text-white px-4 py-2 rounded mt-2 ml-3 text-sm';
    cancelButton.innerHTML = '<i class="fas fa-times mr-1"></i> Cancel';
    cancelButton.onclick = () => cancelEditMessage(messageId);

    // Create button container
    const buttonContainer = document.createElement('div');
    buttonContainer.className = 'edit-buttons flex justify-end mt-3';
    buttonContainer.appendChild(saveButton);
    buttonContainer.appendChild(cancelButton);

    // Clear the content container and add the editing elements
    contentContainer.innerHTML = '';
    contentContainer.appendChild(textarea);
    contentContainer.appendChild(buttonContainer);

    // Focus the textarea and place cursor at the end
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);

    // Add editing class for styling
    contentContainer.classList.add('editing');
}

// Cancel message editing
function cancelEditMessage(messageId) {
    const messageElement = document.querySelector(`[data-message-id="${messageId}"]`);
    if (!messageElement) return;

    const contentContainer = messageElement.querySelector('.message-bubble');
    if (!contentContainer) return;

    // Restore original content from attribute
    const originalContent = contentContainer.getAttribute('data-original-content');
    if (originalContent) {
        contentContainer.innerHTML = originalContent;
    }

    // Remove editing class
    contentContainer.classList.remove('editing');
}

// Save edited message
function saveEditedMessage(messageId, newContent) {
    if (!state.activeChat) return;

    // Trim content but keep internal whitespace
    newContent = newContent.trim();

    // If content is empty, don't save
    if (!newContent) {
        // Show a quick error message
        const messageElement = document.querySelector(`[data-message-id="${messageId}"]`);
        if (messageElement) {
            const textarea = messageElement.querySelector('textarea');
            if (textarea) {
                textarea.classList.add('border-red-500');
                setTimeout(() => {
                    textarea.classList.remove('border-red-500');
                }, 1500);
            }
        }
        return;
    }

    const messages = state.chats[state.activeChat];
    const messageIndex = messages.findIndex(m => m.id === messageId);

    if (messageIndex !== -1) {
        // Update message content
        messages[messageIndex].content = newContent;

        // Add edited flag and timestamp
        messages[messageIndex].edited = true;
        messages[messageIndex].editedAt = new Date().toISOString();

        // Save to storage
        setStoredItem(STORAGE_KEYS.CHATS, state.chats);

        // Update UI directly instead of full re-render
        const messageElement = document.querySelector(`[data-message-id="${messageId}"]`);
        if (messageElement) {
            const bubble = messageElement.querySelector('.message-bubble');
            if (bubble) {
                const deleteBtn = bubble.querySelector('button[id^="delete-msg-"]');
                bubble.innerHTML = processContent(newContent); // Update content
                if (deleteBtn) {
                    bubble.appendChild(deleteBtn); // Re-append delete button
                }
            }

            // Update timestamp and add/update "edited" badge
            const timestampDiv = messageElement.querySelector('.text-xs.text-gray-500.mt-1');
            if (timestampDiv) {
                // Get the message object to check if it's a user or character message
                const message = messages[messageIndex];
                const isUser = message.isUser;
                const characterId = message.characterId;

                // Create new timestamp HTML
                let newTimestampHtml = `<span>`;
                if (message.edited) {
                    newTimestampHtml += `<span class="text-xs italic mr-1">edited</span>`;
                }
                newTimestampHtml += `${new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>`;

                // Set the new timestamp HTML
                timestampDiv.innerHTML = newTimestampHtml;

                // Re-create buttons with proper event handlers instead of cloning
                if (isUser) {
                    // For user messages, check if it's the last user message
                    const userMessages = messages.filter(m => m.isUser && !m.isDeleted && !m.isContinue);
                    const isLastUserMessage = userMessages.length > 0 &&
                        userMessages[userMessages.length - 1].id === messageId;

                    if (isLastUserMessage) {
                        // Create edit button with fresh event handler
                        const editButton = document.createElement('button');
                        editButton.className = 'ml-2 text-primary hover:text-primary/70 edit-msg-btn';
                        editButton.title = "Edit message";
                        editButton.innerHTML = '<i class="fas fa-pencil-alt text-xs"></i>';
                        editButton.onclick = () => editMessage(messageId);
                        timestampDiv.appendChild(editButton);
                    }
                } else {
                    // For character messages
                    const characterMessages = messages.filter(m =>
                        !m.isUser &&
                        m.characterId === characterId &&
                        !m.isDeleted &&
                        !m.isTyping
                    );

                    const isLastCharacterMessage = characterMessages.length > 0 &&
                        characterMessages[characterMessages.length - 1].id === messageId;

                    // Check if this message is followed by a user message
                    const isFollowedByUserMessage = (() => {
                        const messageIndex = messages.findIndex(m => m.id === messageId);
                        for (let i = messageIndex + 1; i < messages.length; i++) {
                            if (messages[i].isUser && !messages[i].isDeleted) return true;
                        }
                        return false;
                    })();

                    const showRegenerateButton = isLastCharacterMessage && !isFollowedByUserMessage && !state.isResponseInProgress;

                    // Add regenerate button if needed
                    if (showRegenerateButton) {
                        const regenerateButton = document.createElement('button');
                        regenerateButton.className = 'ml-4 text-primary hover:text-primary/70 edit-msg-btn';
                        regenerateButton.title = "Regenerate response";
                        regenerateButton.innerHTML = '<i class="fas fa-redo-alt text-xs"></i> <span class="text-xs">Regenerate</span>';
                        regenerateButton.onclick = () => regenerateMessage(characterId);
                        timestampDiv.appendChild(regenerateButton);
                    }

                    // Add edit button if it's the last character message
                    if (isLastCharacterMessage) {
                        const editButton = document.createElement('button');
                        editButton.className = 'ml-4 text-primary hover:text-primary/70 edit-msg-btn';
                        editButton.title = "Edit message";
                        editButton.innerHTML = '<i class="fas fa-pencil-alt text-xs"></i> <span class="text-xs">Edit</span>';
                        editButton.onclick = () => editMessage(messageId);
                        timestampDiv.appendChild(editButton);
                    }
                }
            }

            // Cancel editing mode styling
            const contentContainer = messageElement.querySelector('.message-bubble.editing');
            if (contentContainer) {
                contentContainer.classList.remove('editing');
            }

        } else {
            updateChatMessages(); // Fallback if element not found
        }

        // Show success message
        showSuccess("Message updated", 1500);
    }
}

function clearChatMessages() {
    if (!state.activeChat) return;

    // Ask for confirmation
    if (!confirm("Are you sure you want to clear all messages in this chat?")) {
        return;
    }

    // Clear messages
    state.chats[state.activeChat] = [];

    // Add a system message to indicate the chat was cleared
    const welcomeMsg = {
        id: generateUniqueId(),
        content: `Chat cleared. You can continue your conversation with ${state.activeCharacters.map(c => c.name).join(', ')}.`,
        isUser: false,
        isSystem: true,
        timestamp: new Date().toISOString(),
        isDeleted: false
    };

    // Add welcome message to the chat
    state.chats[state.activeChat].push(welcomeMsg);

    // Update storage
    setStoredItem(STORAGE_KEYS.CHATS, state.chats);

    // Update UI
    updateChatMessages();

    // Show success message
    showSuccess("Chat cleared");
}

// Function to create a new chat with the same character(s)
function createNewChat() {
    if (state.activeCharacters.length === 0) return;

    // Save current chat to history before creating a new one
    saveCurrentChatToHistory();

    // Generate a new chat ID with timestamp to ensure uniqueness
    const timestamp = Date.now();
    const characterIds = state.activeCharacters.map(c => c.id).sort();
    const newChatId = `${characterIds.join('-')}-${timestamp}`;

    // Set the new chat as active
    state.activeChat = newChatId;
    state.chats[newChatId] = [];

    // Save to storage
    setStoredItem(STORAGE_KEYS.CHATS, state.chats);

    // Update the last active chat for each character
    characterIds.forEach(characterId => {
        state.lastActiveChats[characterId] = newChatId;
    });
    setStoredItem(STORAGE_KEYS.LAST_ACTIVE_CHATS, state.lastActiveChats);

    // Create a welcome message for the new chat
    const welcomeMsg = {
        id: generateUniqueId(),
        content: `New conversation started with ${state.activeCharacters.map(c => c.name).join(', ')}`,
        isUser: false,
        isSystem: true,
        timestamp: new Date().toISOString(),
        isDeleted: false
    };

    // Add welcome message to the chat
    state.chats[newChatId].push(welcomeMsg);
    setStoredItem(STORAGE_KEYS.CHATS, state.chats);

    // Save this new chat to history immediately
    const historyEntry = {
        id: newChatId,
        timestamp: timestamp,
        characterIds: characterIds,
        characterNames: state.activeCharacters.map(c => c.name).join(', '),
        messageCount: 1,
        lastMessage: `Start a new conversation with ${state.activeCharacters.map(c => c.name).join(', ')}`,
        date: new Date(timestamp).toLocaleString()
    };

    // Initialize history for these characters if it doesn't exist
    const historyKey = characterIds.join('-');
    if (!state.chatHistory[historyKey]) {
        state.chatHistory[historyKey] = [];
    }

    // Add to history and save
    state.chatHistory[historyKey].push(historyEntry);
    setStoredItem(STORAGE_KEYS.CHAT_HISTORY, state.chatHistory);

    // Update UI
    updateChatUI();

    // Update sidebar to show the most recent characters at the top
    updateSidebarCharacters();

    // Show success message
    showSuccess("Started a new chat");
}

// Function to save current chat to history
function saveCurrentChatToHistory() {
    if (!state.activeChat || !state.chats[state.activeChat] || state.chats[state.activeChat].length === 0) {
        return; // Don't save empty chats
    }

    // Get the character IDs from the chat ID
    const chatParts = state.activeChat.split('-');
    const characterIds = chatParts.filter(part => !isNaN(parseInt(part, 36)) || part.length < 10);

    // Skip if no valid character IDs found
    if (characterIds.length === 0 || !state.activeCharacters || state.activeCharacters.length === 0) {
        return;
    }

    // Get the valid messages (not deleted)
    const validMessages = state.chats[state.activeChat].filter(msg => !msg.isDeleted);
    if (validMessages.length === 0) return; // Don't save if all messages are deleted

    // Find the most recent non-system message for the title
    let lastMessage = validMessages[validMessages.length - 1];
    let lastNonSystemMessage = null;

    // Look for the most recent non-system message
    for (let i = validMessages.length - 1; i >= 0; i--) {
        if (!validMessages[i].isSystem) {
            lastNonSystemMessage = validMessages[i];
            break;
        }
    }

    // If we found a non-system message, use it for the title
    if (lastNonSystemMessage) {
        lastMessage = lastNonSystemMessage;
    }

    // Create a history entry
    const timestamp = Date.now();
    const historyEntry = {
        id: state.activeChat,
        timestamp: timestamp,
        characterIds: characterIds,
        characterNames: state.activeCharacters.map(c => c.name).join(', '),
        messageCount: validMessages.length,
        lastMessage: lastMessage.content ? lastMessage.content.substring(0, 50) + (lastMessage.content.length > 50 ? '...' : '') : 'No content',
        date: new Date(timestamp).toLocaleString()
    };

    // Initialize history for these characters if it doesn't exist
    const historyKey = characterIds.join('-');
    if (!state.chatHistory[historyKey]) {
        state.chatHistory[historyKey] = [];
    }

    // Check if this chat is already in history
    const existingIndex = state.chatHistory[historyKey].findIndex(entry => entry.id === state.activeChat);

    if (existingIndex >= 0) {
        // Update existing entry
        state.chatHistory[historyKey][existingIndex] = historyEntry;
    } else {
        // Add new entry
        state.chatHistory[historyKey].push(historyEntry);
    }

    // Save to storage
    setStoredItem(STORAGE_KEYS.CHAT_HISTORY, state.chatHistory);
}

// Function to show chat history modal
function showChatHistory() {
    if (state.activeCharacters.length === 0) return;

    // Get character IDs
    const characterIds = state.activeCharacters.map(c => c.id).sort();
    const historyKey = characterIds.join('-');

    // Get history for these characters
    const history = state.chatHistory[historyKey] || [];

    // Update the modal content
    const historyList = document.getElementById('chat-history-list');

    if (history.length === 0) {
        historyList.innerHTML = `<p class="text-gray-500 italic text-center">No chat history available</p>`;
    } else {
        // Sort by timestamp, newest first
        const sortedHistory = [...history].sort((a, b) => b.timestamp - a.timestamp);

        // Update each history entry with the most recent message
        sortedHistory.forEach(entry => {
            if (!entry || !entry.id || !state.chats[entry.id]) return;

            // Get the valid messages (not deleted)
            const validMessages = state.chats[entry.id].filter(msg => !msg.isDeleted);
            if (validMessages.length === 0) return;

            // Find the most recent non-system message for the title
            let lastMessage = validMessages[validMessages.length - 1];

            // Look for the most recent non-system message
            for (let i = validMessages.length - 1; i >= 0; i--) {
                if (!validMessages[i].isSystem) {
                    lastMessage = validMessages[i];
                    break;
                }
            }

            // Update the entry with the most recent message
            entry.lastMessage = lastMessage.content ?
                lastMessage.content.substring(0, 50) + (lastMessage.content.length > 50 ? '...' : '') :
                'No content';
            entry.messageCount = validMessages.length;

            // Update the timestamp and date with the most recent message timestamp
            if (lastMessage.timestamp) {
                const messageTimestamp = new Date(lastMessage.timestamp).getTime();
                if (messageTimestamp > 0) {
                    entry.timestamp = messageTimestamp;
                    entry.date = new Date(messageTimestamp).toLocaleString([], { month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
                }
            }
        });

        let html = '';
        sortedHistory.forEach(entry => {
            if (!entry || !entry.id) return; // Skip undefined entries

            html += `
                <div class="mb-4 p-3 bg-gray-50 rounded-lg hover:bg-gray-100 cursor-pointer chat-history-item" data-chat-id="${entry.id}">
                    <div class="flex justify-between items-start">
                        <h4 class="font-medium text-gray-800">${entry.characterNames || 'Unnamed Chat'}</h4>
                        <span class="text-xs text-gray-500">${entry.date || 'No date'}</span>
                    </div>
                    <p class="text-sm text-gray-600 mt-1">${entry.messageCount || 0} messages</p>
                    <div class="mt-2 bg-gray-100 p-2 rounded">
                        <p class="text-sm text-gray-700">${entry.lastMessage || 'No messages'}</p>
                    </div>
                    <div class="mt-2 pt-2 border-t border-gray-200 flex justify-end">
                        <button class="text-red-500 hover:text-red-700 delete-history-btn p-1" 
                                data-chat-id="${entry.id}" 
                                title="Delete this chat history"
                                onclick="event.stopPropagation();">
                            <i class="fas fa-trash-alt"></i> Delete
                        </button>
                    </div>
                </div>
            `;
        });

        historyList.innerHTML = html;

        // Add click listeners to history items
        const historyItems = document.querySelectorAll('.chat-history-item');
        historyItems.forEach(item => {
            item.addEventListener('click', () => {
                const chatId = item.getAttribute('data-chat-id');
                loadChatFromHistory(chatId);
                closeChatHistoryModal();
            });
        });

        // Add click listeners to delete buttons
        const deleteButtons = document.querySelectorAll('.delete-history-btn');
        deleteButtons.forEach(button => {
            button.addEventListener('click', (e) => {
                e.stopPropagation(); // Prevent triggering the parent click
                const chatId = button.getAttribute('data-chat-id');
                deleteChatHistory(chatId, historyKey);
            });
        });
    }

    // Show the modal
    const modal = document.getElementById('chat-history-modal');
    modal.classList.remove('hidden');
}

// Function to close chat history modal
function closeChatHistoryModal() {
    const modal = document.getElementById('chat-history-modal');
    modal.classList.add('hidden');

    // Ensure the chat UI is updated when closing the modal
    // This helps especially after deletion operations
    if (state.activeChat) {
        updateChatUI();
    }
}

// Function to load a chat from history
function loadChatFromHistory(chatId) {
    if (!state.chats[chatId]) {
        showError("Chat not found");
        return;
    }

    // Clean up any "continuing conversation" system messages
    if (state.chats[chatId]) {
        const messages = state.chats[chatId];
        let hasChanges = false;

        // Look for system messages with "..." content (the continue indicator)
        messages.forEach(msg => {
            if (msg.isSystem && msg.content === "..." && !msg.isDeleted) {
                msg.isDeleted = true;
                hasChanges = true;
            }
        });

        // Save changes if needed
        if (hasChanges) {
            setStoredItem(STORAGE_KEYS.CHATS, state.chats);
        }
    }

    // Set as active chat
    state.activeChat = chatId;

    // Update active characters based on the chat ID
    const chatParts = chatId.split('-');
    const characterIds = chatParts.filter(part => !isNaN(parseInt(part, 36)) || part.length < 10);
    state.activeCharacters = state.characters.filter(c => characterIds.includes(c.id)).slice(0, 1);
    state.selectedCharacters = state.activeCharacters.map(c => c.id);

    // Update the last active chat for each character
    characterIds.forEach(characterId => {
        state.lastActiveChats[characterId] = chatId;
    });
    setStoredItem(STORAGE_KEYS.LAST_ACTIVE_CHATS, state.lastActiveChats);

    // Update UI
    updateChatUI();

    // Show success message
    showSuccess("Loaded chat from history");

    // Update sidebar to show the most recent characters at the top
    updateSidebarCharacters();

    // Close the chat history modal
    closeChatHistoryModal();
}

// Function to delete a chat from history
function deleteChatHistory(chatId, historyKey) {
    // Confirm deletion
    if (!confirm("Are you sure you want to delete this chat history?")) {
        return;
    }

    // Check if this is the currently active chat
    const isActiveChatDeleted = (state.activeChat === chatId);

    // Remove from history
    if (state.chatHistory[historyKey]) {
        state.chatHistory[historyKey] = state.chatHistory[historyKey].filter(entry => entry.id !== chatId);

        // If history is empty for this character, remove the key
        if (state.chatHistory[historyKey].length === 0) {
            delete state.chatHistory[historyKey];
        }

        // Save to storage
        setStoredItem(STORAGE_KEYS.CHAT_HISTORY, state.chatHistory);

        // If we deleted the active chat, load another chat
        if (isActiveChatDeleted) {
            // Get the character IDs from the history key
            const characterIds = historyKey.split('-');

            // Find another chat for the same character(s)
            let foundAnotherChat = false;

            // First try to find another chat with the same characters
            if (state.chatHistory[historyKey] && state.chatHistory[historyKey].length > 0) {
                // Sort chats by timestamp, newest first
                const sortedHistory = [...state.chatHistory[historyKey]].sort((a, b) => b.timestamp - a.timestamp);
                if (sortedHistory.length > 0 && sortedHistory[0].id && state.chats[sortedHistory[0].id]) {
                    // Load the most recent chat for this character
                    loadChatFromHistory(sortedHistory[0].id);
                    foundAnotherChat = true;
                    showSuccess("Deleted chat and loaded most recent conversation");
                }
            }

            // If we couldn't find another chat for the same character, create a new one
            if (!foundAnotherChat) {
                // Get the actual character objects based on IDs
                const activeCharacters = state.characters.filter(c => characterIds.includes(c.id));
                if (activeCharacters.length > 0) {
                    // Set active characters and create a new chat
                    state.activeCharacters = activeCharacters.slice(0, 1);
                    createNewChat();
                    showSuccess("Deleted chat and started a new conversation");
                } else {
                    // Clear the active chat since we couldn't find a suitable replacement
                    state.activeChat = null;
                    state.activeCharacters = [];
                    updateChatUI();
                    showError("Chat deleted. Please select a character to start a new conversation.");
                }
            }
        } else {
            // Refresh the history modal
            showChatHistory();

            // Show success message
            showSuccess("Chat history deleted");
        }
    }
}

async function sendMessage() {
    // Ensure we have an active chat
    if (!state.activeChat || !state.chats[state.activeChat]) {
        showError("No active chat. Please select a character to chat with.");
        return;
    }

    // Ensure we have active characters
    if (!state.activeCharacters || state.activeCharacters.length === 0) {
        console.error("No active characters found");
        state.activeCharacters = [];

        // Try to recover the active characters from the active chat ID
        // The chat ID should contain the character IDs
        const chatParts = state.activeChat.split('-');
        const characterIds = chatParts.filter(part => part.length < 10);

        if (characterIds.length > 0) {
            // Recover the characters from the IDs
            console.log("Attempting to recover characters from chat ID:", characterIds);
            state.activeCharacters = characterIds.map(id =>
                state.characters.find(c => c.id === id)
            ).filter(c => c); // Remove any undefined entries

            if (state.activeCharacters.length === 0) {
                showError("Could not recover characters for this chat. Please start a new chat.");
                return;
            }

            console.log("Recovered characters:", state.activeCharacters);
        } else {
            // If we can't recover the characters, suggest creating a new chat
            showError("No characters selected. Please start a new chat.");
            return;
        }
    }

    if (state.activeCharacters.length > 1) {
        state.activeCharacters = [state.activeCharacters[0]];
        state.selectedCharacters = [state.activeCharacters[0].id];
    }

    // If a response is already in progress, prevent sending another message
    if (state.isResponseInProgress) {
        console.log("Response is already in progress, ignoring send request");
        showError("Please wait for the current response to finish before sending another message.");
        return;
    }

    const messageInput = document.getElementById('message-input');
    const userMessage = messageInput.value.trim();

    // Clear input regardless of content
    messageInput.value = '';

    // Set UI to show that a response is in progress
    state.isResponseInProgress = true;
    updateSendButtonState();

    try {
        // Check if we have an empty message
        if (!userMessage) {
            // Check if there's been at least one exchange (user and character) before allowing continue
            const hasExchanges = (() => {
                if (!state.activeChat) return false;
                const messages = state.chats[state.activeChat] || [];
                const userMsgs = messages.filter(m => m.isUser && !m.isDeleted && !m.isContinue);
                const charMsgs = messages.filter(m => !m.isUser && !m.isDeleted && !m.isSystem);

                return userMsgs.length > 0 && charMsgs.length > 0;
            })();

            if (!hasExchanges) {
                showError("Please start the conversation before using the 'continue' feature");
                state.isResponseInProgress = false;
                updateSendButtonState();
                return;
            }

            // Track the current chat ID to ensure we remove the message from the correct chat
            const currentChatId = state.activeChat;

            // For empty messages, add a subtle system message indicating the continue action
            const continueSystemMsg = {
                id: generateUniqueId(),
                content: "...",
                isUser: false,
                isSystem: true,
                timestamp: new Date().toISOString(),
                isDeleted: false
            };

            // Add this subtle indicator to the UI but mark it for auto-removal
            addMessage(continueSystemMsg);

            // Track the system message ID so we can ensure it's removed in cleanup
            let continueSystemMsgId = continueSystemMsg.id;

            // Remove the system message after a short delay or on error
            const removeSystemMessage = () => {
                // Use the stored chatId rather than the possibly changed active chat
                if (state.chats[currentChatId]) {
                    const messages = state.chats[currentChatId];
                    const msgIndex = messages.findIndex(m => m.id === continueSystemMsgId);
                    if (msgIndex !== -1) {
                        messages[msgIndex].isDeleted = true;
                        setStoredItem(STORAGE_KEYS.CHATS, state.chats);

                        // Only update UI if we're still on the same chat
                        if (state.activeChat === currentChatId) {
                            updateChatMessages();
                        }
                    }
                }
            };

            // Set a timeout to remove the message regardless of what happens
            setTimeout(removeSystemMessage, 1500);

            // Get response from each character using async/await and Promise.all for concurrency
            try {
                await Promise.all(state.activeCharacters.map(async (character) => {
                    // Create a special "continue" message that won't be displayed
                    const continueMsg = {
                        id: generateUniqueId(),
                        content: "", // Empty content, just internal signal to continue
                        isUser: true,
                        timestamp: new Date().toISOString(),
                        isDeleted: true, // Mark as deleted so it won't show in the UI
                        isContinue: true // Special flag to mark this as a continue message
                    };

                    // Generate a response without adding the continue message to the visible chat history
                    await getCharacterResponse(character, continueMsg);
                }));

                // Ensure message is removed even if responses complete quickly
                removeSystemMessage();

            } catch (error) {
                // Make sure the system message is cleaned up on error
                removeSystemMessage();
                throw error; // Re-throw to be caught by outer try-catch
            }
        } else {
            // Store current active chat ID to track if user switches chats during response
            const currentChatId = state.activeChat;

            // Add user message
            const userMsg = {
                id: generateUniqueId(),
                content: userMessage,
                isUser: true,
                timestamp: new Date().toISOString(),
                isDeleted: false,
            };

            // Add the user message to the chat
            addMessage(userMsg);

            // Get response from each character using async/await and Promise.all
            await Promise.all(state.activeCharacters.map(character =>
                getCharacterResponse(character, userMsg)
            ));
        }
    } catch (error) {
        console.error("Error sending message:", error);
        showError("Failed to get response. " + (error.message || "Please try again."));
    } finally {
        state.isResponseInProgress = false;
        updateSendButtonState();
        updateChatMessages();
    }
}

// Function to update the send button state
function updateSendButtonState() {
    const sendButton = document.getElementById('send-message-btn');
    if (sendButton) {
        if (state.isResponseInProgress) {
            // Disable the button
            sendButton.disabled = true;
            sendButton.classList.add('disabled');
            sendButton.classList.add('opacity-50');
            sendButton.classList.add('cursor-not-allowed');
            sendButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';

            // Also disable the message input
            const messageInput = document.getElementById('message-input');
            if (messageInput) {
                messageInput.disabled = true;
                messageInput.classList.add('opacity-50');
                messageInput.classList.add('cursor-not-allowed');
                messageInput.placeholder = "Please wait for response...";
            }
        } else {
            // Re-enable the button
            sendButton.disabled = false;
            sendButton.classList.remove('disabled');
            sendButton.classList.remove('opacity-50');
            sendButton.classList.remove('cursor-not-allowed');
            sendButton.innerHTML = '<i class="fas fa-paper-plane"></i>';

            // Re-enable the message input
            const messageInput = document.getElementById('message-input');
            if (messageInput) {
                messageInput.disabled = false;
                messageInput.classList.remove('opacity-50');
                messageInput.classList.remove('cursor-not-allowed');
                messageInput.placeholder = "Type your message... (Enter for new line)";
            }
        }
    }
}

function getResponseStatusText(character, startedAt) {
    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    const providerName = getProviderDisplayName();
    const isLocalProvider = getCurrentProvider() !== AI_PROVIDERS.GEMINI;

    if (elapsedSeconds < 5) {
        return `${character.name} is thinking...`;
    }

    if (elapsedSeconds < 15) {
        return `${providerName} is preparing the reply (${elapsedSeconds}s)...`;
    }

    if (isLocalProvider && elapsedSeconds < 45) {
        return `Local model is still generating (${elapsedSeconds}s). First tokens can take a while.`;
    }

    return `Still generating (${elapsedSeconds}s). Please wait; sending and regenerate are paused.`;
}

function updateTypingIndicatorStatus(typingMsgId, statusText) {
    for (const chatId in state.chats) {
        const messages = state.chats[chatId];
        if (!messages) continue;

        const typingMessage = messages.find(m => m.id === typingMsgId);
        if (!typingMessage) continue;

        typingMessage.content = statusText;

        if (chatId === state.activeChat) {
            const messageElement = document.querySelector(`[data-message-id="${typingMsgId}"]`);
            const statusElement = messageElement?.querySelector('.typing-status-text');
            if (statusElement) {
                statusElement.textContent = statusText;
            }

            const messagesContainer = document.getElementById('chat-messages');
            if (messagesContainer) {
                messagesContainer.scrollTop = messagesContainer.scrollHeight;
            }
        }

        return;
    }
}

function startResponseStatusUpdates(typingMsgId, character) {
    const startedAt = Date.now();
    updateTypingIndicatorStatus(typingMsgId, getResponseStatusText(character, startedAt));

    return setInterval(() => {
        updateTypingIndicatorStatus(typingMsgId, getResponseStatusText(character, startedAt));
    }, 3000);
}

function clearResponseStatusUpdates(timerId) {
    if (timerId) {
        clearInterval(timerId);
    }
}
function addMessage(message) {
    // If we have a pending response for a character that's not the active chat
    // Store it in the right chat but don't update the UI
    if (message.characterId && state.pendingResponses[message.characterId]) {
        const chatId = state.pendingResponses[message.characterId].chatId;

        // Make sure the chat exists
        if (!state.chats[chatId]) {
            state.chats[chatId] = [];
        }

        // Add message to the correct chat
        state.chats[chatId].push(message);
        setStoredItem(STORAGE_KEYS.CHATS, state.chats);

        // Only update UI if this is for the active chat
        if (chatId === state.activeChat) {
            updateChatMessages();

            if (!message.isTyping) {
                updateSidebarCharacters();

                // Update chat history entry if this is a real message (not typing indicator)
                if (!message.isSystem) {
                    saveCurrentChatToHistory();
                }
            }
        }

        return;
    }

    // Normal flow for active chat
    if (!state.activeChat) return;

    // Add message to chat
    if (!state.chats[state.activeChat]) {
        state.chats[state.activeChat] = [];
    }

    state.chats[state.activeChat].push(message);
    setStoredItem(STORAGE_KEYS.CHATS, state.chats);

    // Create the DOM element for the new message
    const messageElement = createMessageHTML(message);
    const messagesContainer = document.getElementById('chat-messages');

    if (messagesContainer && messageElement) {
        // Remove "no messages" placeholder if it exists
        const noMessagesPlaceholder = messagesContainer.querySelector('.text-center.text-gray-500');
        if (noMessagesPlaceholder) {
            noMessagesPlaceholder.remove();
        }
        // Append the new message element
        messagesContainer.appendChild(messageElement);
        // Scroll to the new message
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
    } else if (messagesContainer && !messageElement && (state.chats[state.activeChat]?.length || 0) === 0) {
        // If messageElement is null (e.g. a system message we don't want to render yet)
        // and the chat is empty, ensure the placeholder is shown.
        messagesContainer.innerHTML = `
            <div class="text-center text-gray-500 mt-8">
                <p>No messages yet. Start the conversation!</p>
            </div>
        `;
    } else if (messagesContainer && !messageElement) {
        // If messageElement is null but there are other messages,
        // it might be a non-renderable message, do nothing to the DOM here.
        // updateChatMessages() would be too broad.
    }

    // Update sidebar to reflect new message timestamp
    if (!message.isTyping) {
        updateSidebarCharacters();

        // Update chat history entry if this is a real message (not typing indicator)
        if (!message.isSystem) {
            saveCurrentChatToHistory();
        }
    }
}

async function getCharacterResponse(character, userMsg) {
    // Determine which chat this response belongs to
    const chatId = state.activeChat;

    // Track that we're generating a response for this character in this chat
    state.pendingResponses[character.id] = {
        chatId: chatId,
        isGenerating: true
    };
    let responseStatusTimer = null;

    try {
        // Get visible messages for context (excluding any that are marked as deleted)
        const visibleMessages = state.chats[chatId].filter(m => !m.isDeleted);

        // Check if this is the first message in the conversation
        const isFirstMessage = (() => {
            const characterMessages = visibleMessages.filter(m =>
                !m.isUser &&
                m.characterId === character.id &&
                !m.isSystem &&
                !m.isTyping
            );
            return characterMessages.length === 0;
        })();

        // Check if this is a continue message
        const isContinue = userMsg && userMsg.isContinue === true;

        // Add typing indicator for better UX
        const typingMsg = {
            id: generateUniqueId(),
            content: "",
            isUser: false,
            characterId: character.id,
            timestamp: new Date().toISOString(),
            isTyping: true,
            isDeleted: false
        };

        // Add the typing indicator
        addMessage(typingMsg);
        responseStatusTimer = startResponseStatusUpdates(typingMsg.id, character);

        // Simulate a minimal typing delay based on character and context
        // This makes the interaction feel more natural
        const minTypingDelay = 500; // base minimum delay

        // Calculate a more natural variable typing delay based on message complexity
        // Consider character complexity, previous message length, and a bit of randomness
        const baseDelay = Math.max(minTypingDelay, Math.min(2000, visibleMessages.length * 100));
        const randomVariation = Math.floor(Math.random() * 800) - 400; // -400 to +400ms variation
        const typingDelay = Math.max(minTypingDelay, baseDelay + randomVariation);

        await new Promise(resolve => setTimeout(resolve, typingDelay));

        let promptContext;

        if (isFirstMessage && !isContinue) {
            // For the first message, we include the full character context
            console.log("First message in conversation, using full character context");
            promptContext = prepareContextForAPI(
                character,
                visibleMessages,
                state.characters.filter(c => chatId.includes(c.id)) // Use characters for this specific chat
            );

            try {
                // Use a simpler approach for the first message
                const result = await callGeminiAPI(promptContext);

                // Check if we're still generating a response for this character
                if (state.pendingResponses[character.id] && state.pendingResponses[character.id].chatId === chatId) {
                    // Remove typing indicator
                    removeTypingIndicator(typingMsg.id);

                    // Add the response as a message
                    addMessage({
                        id: generateUniqueId(),
                        content: result,
                        isUser: false,
                        characterId: character.id,
                        timestamp: new Date().toISOString(),
                        isDeleted: false,
                    });
                }
            } catch (error) {
                // Make sure to remove typing indicator even on error
                removeTypingIndicator(typingMsg.id);
                throw error; // Re-throw to be caught by outer try-catch
            }

            return;
        }

        // For subsequent messages, use the conversation history approach with Gemini Chat
        console.log("Using chat history approach for response");

        // Convert visible history for Gemini API
        const history = convertHistoryForGemini(visibleMessages, character);

        // Log the history for debugging
        if (window.debugApp) {
            console.log("History being sent to API:", JSON.stringify(history));
        }

        // Check if history is valid
        if (history.length === 0) {
            console.warn("Empty history after conversion, falling back to basic prompt");
            // Remove typing indicator
            removeTypingIndicator(typingMsg.id);

            // Create a basic prompt instead
            promptContext = prepareContextForAPI(
                character,
                visibleMessages,
                state.characters.filter(c => chatId.includes(c.id)) // Use characters for this specific chat
            );

            try {
                // Use a simpler approach as fallback
                const result = await callGeminiAPI(promptContext);

                // Only add the response if we're still responding to the same chat
                if (state.pendingResponses[character.id] && state.pendingResponses[character.id].chatId === chatId) {
                    // Add the response as a message
                    addMessage({
                        id: generateUniqueId(),
                        content: result,
                        isUser: false,
                        characterId: character.id,
                        timestamp: new Date().toISOString(),
                        isDeleted: false,
                    });
                }
                return;
            } catch (error) {
                throw new Error("Failed to get response with fallback method: " + error.message);
            }
        }

        // Get character-specific instructions without sending the full context
        let instructions = "";

        if (userMsg.isInitializing) {
            // Special instructions for first-time greeting
            instructions = `You are ${character.name}. This is the start of a new conversation with the user.
Introduce yourself briefly in a way that's true to your character's personality and background.
Keep it relatively short (1-2 paragraphs) and inviting to encourage the user to respond.
Don't address the user by name unless they've already told you their name.`;
        } else if (isContinue) {
            // Special instructions for continue messages
            instructions = `The user pressed send without typing any message, which means they want you to continue the roleplay on your own. 
As ${character.name}, continue the conversation by advancing the scene or narrative naturally. 
Keep roleplaying autonomously, continuing from your last message. 
Do not acknowledge this as a command or mention that the user sent an empty message.`;
        } else {
            // Regular instructions - just a reminder about the character
            instructions = `Remember that you are roleplaying as ${character.name}. 
Stay in character and respond naturally to the user's message.`;
        }

        instructions += `\n${NO_THINKING_INSTRUCTION}`;

        try {
            await ensureAIProviderReady();

            if (getCurrentProvider() !== AI_PROVIDERS.GEMINI) {
                updateTypingIndicatorStatus(typingMsg.id, `${getProviderDisplayName()} is generating the reply...`);

                const localMessages = buildLocalChatMessages(character, history, instructions);
                const localResponse = await callAIChat(localMessages, appSettings.conversationTokens || appSettings.maxTokens);

                if (state.pendingResponses[character.id] && state.pendingResponses[character.id].chatId === chatId) {
                    removeTypingIndicator(typingMsg.id);
                    addMessage({
                        id: generateUniqueId(),
                        content: localResponse || `*${character.name} did not return any text*`,
                        isUser: false,
                        characterId: character.id,
                        timestamp: new Date().toISOString(),
                        isDeleted: false,
                    });
                }

                console.log("Local provider response complete, length:", (localResponse || "").length);
                return;
            }
            // Create a chat with the history using the Gemini SDK.
            const modelName = getGeminiModelName();
            const generationConfig = buildGeminiGenerationConfig(appSettings.conversationTokens || appSettings.maxTokens);
            console.log("Creating Gemini chat with model:", modelName, "config:", generationConfig);

            const chat = state.genaiClient.chats.create({
                model: modelName,
                history: history,
                config: generationConfig,
            });

            // Prepare for the new response, but do not create a blank bubble before text arrives.
            let fullResponse = "";
            let responseMsg = null;
            // Determine typing speed based on character personality
            // This makes characters with verbose personalities type slower than terse ones
            const baseCharSpeed = character.enhancedContext ?
                (character.enhancedContext.includes("talkative") ||
                    character.enhancedContext.includes("verbose") ? 30 : 50) : 40;

            // Track the last update time for natural typing simulation
            let lastUpdateTime = Date.now();
            // let accumulatedText = ""; // Replaced by accumulatedRawResponse for clarity
            let accumulatedRawResponse = ""; // Accumulates raw text for final state update & processing

            // Function to simulate natural typing behavior - RETHINKING THIS
            // The main streaming loop will call updateMessageContent directly.
            // We don't strictly need updateWithTypingEffect anymore if logic is in the main loop.

            try {
                const streamSource = (isContinue || userMsg.isInitializing) ? instructions : instructions; // Simplified, actual message is sent via chat.sendMessageStream
                console.log("Sending message stream...");
                const result = await chat.sendMessageStream({ message: streamSource });

                for await (const chunk of result) {
                    // Handle cases where chunk.text might be undefined
                    const chunkText = chunk.text || "";
                    if (!chunkText) continue; // Skip empty chunks

                    if (!state.pendingResponses[character.id] || state.pendingResponses[character.id].chatId !== chatId) {
                        break; // Stop processing if chat context changed or response cancelled
                    }

                    if (!responseMsg) {
                        removeTypingIndicator(typingMsg.id);
                        responseMsg = {
                            id: generateUniqueId(),
                            content: "",
                            isUser: false,
                            characterId: character.id,
                            timestamp: new Date().toISOString(),
                            isDeleted: false,
                        };
                        addMessage(responseMsg);
                    }

                    updateMessageContent(responseMsg.id, chunkText, false); // Stream update (isFinalUpdate = false)
                    accumulatedRawResponse += chunkText; // Accumulate raw text
                    fullResponse = accumulatedRawResponse;
                }

                // Final update after loop: Process content and save final raw state
                if (state.pendingResponses[character.id] && state.pendingResponses[character.id].chatId === chatId) {
                    if (responseMsg && accumulatedRawResponse) {
                        const finalMessageInState = state.chats[chatId].find(m => m.id === responseMsg.id);
                        if (finalMessageInState) {
                            finalMessageInState.content = accumulatedRawResponse; // Store the raw, complete text
                            setStoredItem(STORAGE_KEYS.CHATS, state.chats); // Save state with final raw content
                        }
                        // Call updateMessageContent with isFinalUpdate = true to apply processContent
                        updateMessageContent(responseMsg.id, accumulatedRawResponse, true);
                    } else {
                        removeTypingIndicator(typingMsg.id);
                        addMessage({
                            id: generateUniqueId(),
                            content: `*${character.name} did not return any text*`,
                            isUser: false,
                            characterId: character.id,
                            timestamp: new Date().toISOString(),
                            isDeleted: false,
                        });
                    }
                }
                console.log("Full response complete, length:", accumulatedRawResponse.length);
            } catch (error) {
                console.error("Stream error:", error);
                // If streaming fails, try to process and display what was received, or an error message.
                if (state.pendingResponses[character.id] &&
                    state.pendingResponses[character.id].chatId === chatId) {

                    if (fullResponse.length < 10) {
                        // If we've barely started, try to get at least something to display
                        try {
                            const emergencyResponse = await callGeminiAPI(
                                `As ${character.name}, please respond to: "${userMsg.content || 'Continue the conversation'}" (Keep it brief and in character)`
                            );
                            if (!responseMsg) {
                                removeTypingIndicator(typingMsg.id);
                                addMessage({
                                    id: generateUniqueId(),
                                    content: emergencyResponse,
                                    isUser: false,
                                    characterId: character.id,
                                    timestamp: new Date().toISOString(),
                                    isDeleted: false,
                                });
                            } else {
                                updateMessageContent(responseMsg.id, emergencyResponse, true);
                            }
                        } catch (fallbackError) {
                            // If even that fails, add an apologetic message
                            if (!responseMsg) {
                                removeTypingIndicator(typingMsg.id);
                                addMessage({
                                    id: generateUniqueId(),
                                    content: `*${character.name} seems unable to respond at the moment*`,
                                    isUser: false,
                                    characterId: character.id,
                                    timestamp: new Date().toISOString(),
                                    isDeleted: false,
                                });
                            } else {
                                updateMessageContent(responseMsg.id, `*${character.name} seems unable to respond at the moment*`, true);
                            }                        }
                    }
                }
                throw error; // Still throw the error for the outer catch block
            }
        } catch (error) {
            // Only handle specific API errors if this response is still relevant
            if (state.pendingResponses[character.id] &&
                state.pendingResponses[character.id].chatId === chatId) {

                if (error.message && error.message.includes('First content should be with role')) {
                    console.error("History format error:", error.message);

                    // Try a simplified approach
                    removeTypingIndicator(typingMsg.id);

                    // Add a system message
                    addMessage({
                        id: generateUniqueId(),
                        content: "Trying a different approach to get a response...",
                        isUser: false,
                        isSystem: true,
                        timestamp: new Date().toISOString(),
                        isDeleted: false
                    });

                    // Create a new empty typing indicator
                    const newTypingMsg = {
                        id: generateUniqueId(),
                        content: "",
                        isUser: false,
                        characterId: character.id,
                        timestamp: new Date().toISOString(),
                        isTyping: true,
                        isDeleted: false
                    };

                    // Add it
                    addMessage(newTypingMsg);

                    // Small delay
                    await new Promise(resolve => setTimeout(resolve, 500));

                    try {
                        // Try a direct prompt approach instead
                        const promptContext = prepareContextForAPI(
                            character,
                            visibleMessages.slice(-5), // Use only the last 5 messages to reduce context
                            state.characters.filter(c => chatId.includes(c.id))
                        );

                        const result = await callGeminiAPI(promptContext + `\nRespond as ${character.name} to the last message from the user: "${userMsg.content || 'Continue the conversation naturally'}"`);

                        // Remove typing indicator
                        removeTypingIndicator(newTypingMsg.id);

                        // Add response
                        addMessage({
                            id: generateUniqueId(),
                            content: result,
                            isUser: false,
                            characterId: character.id,
                            timestamp: new Date().toISOString(),
                            isDeleted: false
                        });

                        return;
                    } catch (fallbackError) {
                        console.error("Fallback attempt also failed:", fallbackError);

                        // Remove typing indicator
                        removeTypingIndicator(newTypingMsg.id);

                        // Add error message
                        addMessage({
                            id: generateUniqueId(),
                            content: `*${character.name} is unable to respond right now*`,
                            isUser: false,
                            characterId: character.id,
                            timestamp: new Date().toISOString(),
                            isDeleted: false
                        });
                    }
                } else {
                    console.error("API error:", error);
                    showError(`Failed to get response: ${error.message}`);
                }
            }
        } finally {
            clearResponseStatusUpdates(responseStatusTimer);
            // Clean up the pending response status when done
            if (state.pendingResponses[character.id] &&
                state.pendingResponses[character.id].chatId === chatId) {
                state.pendingResponses[character.id].isGenerating = false;
            }
        }
    } catch (error) {
        clearResponseStatusUpdates(responseStatusTimer);
        console.error("Error in getCharacterResponse:", error);
        // Make sure any pending statuses for this character/chat are cleaned up
        if (state.pendingResponses[character.id] &&
            state.pendingResponses[character.id].chatId === chatId) {
            state.pendingResponses[character.id].isGenerating = false;
        }
    }
}

// Process content with markdown - moved to a higher scope
const processContent = (content) => {
    marked.setOptions({
        breaks: true, gfm: true, headerIds: false, mangle: false,
    });
    content = content.replace(/\*((?!\*)[^*]+)\*/g, (match, action) => `<em class="roleplay-action">${action.replace(/\*/g, '')}</em>`);
    content = content.replace(/##\s*([^#]+)\s*##/g, (match, scene) => `<div class="scene-transition">${scene}</div>`);
    content = content.replace(/\((?:OOC|ooc|p\.s\.):\s*([^)]+)\)/g, (match, ooc) => `<span class="ooc-comment">(OOC: ${ooc})</span>`);
    content = content.replace(/__((?!\s)[^_]+)__/g, '<strong>$1</strong>');
    const rawHtml = marked.parse(content);
    return DOMPurify.sanitize(rawHtml, {
        ALLOWED_TAGS: ['em', 'strong', 'code', 'br', 'p', 'ul', 'ol', 'li', 'blockquote', 'i', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'hr', 'del', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'div', 'span'],
        ALLOWED_ATTR: ['class', 'style'],
    });
};

// Helper function to update message content
function updateMessageContent(messageId, newContent, isFinalUpdate = false) {
    const messageElement = document.querySelector(`[data-message-id="${messageId}"]`);
    const messagesContainer = document.getElementById('chat-messages');

    if (messageElement) {
        const textContentElement = messageElement.querySelector('.message-text-content');
        if (textContentElement) {
            if (!isFinalUpdate) { // Streaming intermediate chunks
                textContentElement.textContent += newContent; // Append raw text chunk
                if (messagesContainer) {
                    messagesContainer.scrollTop = messagesContainer.scrollHeight; // Scroll down
                }
            } else { // Final update, streaming complete
                textContentElement.innerHTML = processContent(newContent); // Process full raw content
                // Ensure other elements like delete button are preserved if they were outside .message-text-content
                // This relies on createMessageHTML structuring .message-text-content to only contain the text.
            }
        } else {
            console.warn(`.message-text-content not found for messageId: ${messageId}`);
        }
    } else {
        // If the message element doesn't exist yet (e.g., initial addMessage call for a streaming response)
        // this function might be called. addMessage should handle creating the initial element.
        // This specific call to updateMessageContent might be for a message not yet in DOM or for background.
        console.warn(`Message element with ID ${messageId} not found in DOM for content update.`);
    }

    // Update message content in state.
    // For streaming, newContent is a chunk. For final, it's the full raw response.
    // The state should always store the raw, unprocessed content.
    let messageUpdatedInState = false;
    for (const chatId in state.chats) {
        if (state.chats[chatId]) {
            const messageIndex = state.chats[chatId].findIndex(m => m.id === messageId);
            if (messageIndex !== -1) {
                if (!isFinalUpdate) {
                    // If it's the first chunk for a message that was previously empty
                    if (state.chats[chatId][messageIndex].content === "") {
                        state.chats[chatId][messageIndex].content = newContent;
                    } else {
                        state.chats[chatId][messageIndex].content += newContent;
                    }
                } else {
                    state.chats[chatId][messageIndex].content = newContent; // Set the final raw content
                }
                // Save to localStorage only on final update to avoid frequent writes during streaming.
                if (isFinalUpdate) {
                    setStoredItem(STORAGE_KEYS.CHATS, state.chats);
                }
                messageUpdatedInState = true;
                break;
            }
        }
    }
    if (!messageUpdatedInState) {
        console.warn(`Message with ID ${messageId} not found in state for content update.`);
    }
}


// Helper function to find the typing indicator and remove it
function removeTypingIndicator(typingMsgId) {
    // Check if this is a pending response in background
    for (const characterId in state.pendingResponses) {
        const pendingData = state.pendingResponses[characterId];
        const chatId = pendingData.chatId;

        if (chatId && state.chats[chatId]) {
            const messages = state.chats[chatId];
            const typingIndex = messages.findIndex(m => m.id === typingMsgId);

            if (typingIndex !== -1) {
                messages.splice(typingIndex, 1);
                setStoredItem(STORAGE_KEYS.CHATS, state.chats);

                // Only update UI if this is for the active chat
                if (chatId === state.activeChat) {
                    updateChatMessages();
                }

                return;
            }
        }
    }

    // Normal flow for active chat
    if (!state.activeChat) return;

    const messages = state.chats[state.activeChat];
    const typingIndex = messages.findIndex(m => m.id === typingMsgId);

    if (typingIndex !== -1) {
        messages.splice(typingIndex, 1);
        setStoredItem(STORAGE_KEYS.CHATS, state.chats);
        updateChatMessages();
    }
}

// Context preparation for chat
function prepareContextForAPI(character, chatHistory, activeCharacters = []) {
    // Calculate approximate word count based on token limit (0.75 tokens per word)
    const wordLimit = Math.floor(appSettings.conversationTokens * 0.75);

    // Base context with character information and roleplay instructions
    let context = `You are ${character.name}. You must maintain your character's personality and traits at all times.

CHARACTER PROFILE:
${character.enhancedContext
            ? character.enhancedContext
            : character.userContext}

${state.personalContext.name || state.personalContext.personality || state.personalContext.context ? `ABOUT THE PERSON YOU ARE TALKING TO:
${state.personalContext.name ? `Their name is ${state.personalContext.name}. Always use their name when appropriate.` : ''}
${state.personalContext.personality ? `\nTheir personality: ${state.personalContext.personality}` : ''}
${state.personalContext.context ? `\nAdditional context about them: ${state.personalContext.context}` : ''}\n` : ''}

ROLEPLAY GUIDELINES:
- Stay in character at all times - you ARE ${character.name}
- Never break character or mention being an AI
- Do not output visible thinking, chain-of-thought, or <think> sections; reply directly and fully in character
- Respond naturally based on your character's personality and the user's known traits
- Use natural conversational language and emotional responses
- If the user has shared their name or traits, incorporate these naturally into your responses
- For empty messages (continue), advance the conversation naturally while staying in character
- Maintain continuity with previous messages and scene
- Use *italics* for actions/emotions and __bold__ for emphasis. Avoid using *italics* within *italics* or __bold__ within __bold__.
- Use ## for scene descriptions when appropriate
- Keep responses engaging and true to your character's personality
- You can read () for thoughts or context.
- If the user wants to end the conversation/roleplay by saying e.g. "The End", you can say naturally to your character "Goodbye!" or "It was nice talking to you!" or "It was fun roleplaying with you!"`;

    // Add conversation history with smart context management
    if (chatHistory.length > 0) {
        const relevantMessages = chatHistory.filter(msg => !msg.isDeleted && !msg.isTyping);

        if (relevantMessages.length > 0) {
            // Always include the first exchange to maintain the conversation's origin
            const firstExchange = relevantMessages.slice(0, 2);

            // Get the most recent messages
            const recentMessages = relevantMessages.slice(-5);

            // If we have a long conversation, add a summary of key points
            if (relevantMessages.length > 7) {
                // Add first exchange
                context += "\n\nCONVERSATION START:\n" + firstExchange.map(msg => {
                    if (msg.isUser) {
                        return `${state.personalContext.name ? state.personalContext.name : "User"}: ${msg.content}`;
                    } else if (msg.characterId === character.id) {
                        return `${character.name}: ${msg.content}`;
                    }
                }).join('\n');

                // Add a transition
                context += "\n\n[Several messages exchanged, maintaining the conversation's flow and themes...]\n\n";
            }

            // Add recent messages
            context += "RECENT CONVERSATION:\n" + recentMessages.map(msg => {
                if (msg.isUser) {
                    return `${state.personalContext.name ? state.personalContext.name : "User"}: ${msg.content}`;
                } else if (msg.characterId === character.id) {
                    return `${character.name}: ${msg.content}`;
                } else {
                    const msgCharacter = state.characters.find(c => c.id === msg.characterId);
                    return msgCharacter ? `${msgCharacter.name}: ${msg.content}` : `Unknown: ${msg.content}`;
                }
            }).join('\n');
        }
    }

    return context;
}

// Convert history to the format expected by Gemini API
function convertHistoryForGemini(chatHistory, currentCharacter) {
    const formattedHistory = [];
    let hasUserMessage = false;

    // First, check if there's at least one user message in the history
    for (const msg of chatHistory) {
        if (msg.isUser && !msg.isDeleted && !msg.isContinue) {
            hasUserMessage = true;
            break;
        }
    }

    // If no user messages, create a natural conversation starter
    if (!hasUserMessage) {
        const greeting = state.personalContext.name
            ? `Hello ${state.personalContext.name}`
            : "Hello";

        formattedHistory.push({
            role: "user",
            parts: [{ text: greeting }]
        });
        return formattedHistory;
    }

    // Filter relevant messages
    const relevantMessages = chatHistory.filter(msg => {
        if (msg.isTyping || (msg.isDeleted && !msg.isContinue)) return false;
        if (msg.isContinue) return false;
        return msg.isUser || msg.characterId === currentCharacter.id || msg.characterId;
    });

    // Process messages
    let lastRole = null;
    let combinedUserMessage = "";

    for (let i = 0; i < relevantMessages.length; i++) {
        const msg = relevantMessages[i];

        if (msg.isUser) {
            if (lastRole === "user" && combinedUserMessage) {
                formattedHistory.push({
                    role: "user",
                    parts: [{ text: combinedUserMessage }]
                });
                combinedUserMessage = msg.content;
            } else {
                combinedUserMessage = msg.content;
                lastRole = "user";
            }

            if (i === relevantMessages.length - 1 || !relevantMessages[i + 1].isUser) {
                formattedHistory.push({
                    role: "user",
                    parts: [{ text: combinedUserMessage }]
                });
                combinedUserMessage = "";
            }
        } else if (msg.characterId === currentCharacter.id) {
            formattedHistory.push({
                role: "model",
                parts: [{ text: msg.content }]
            });
            lastRole = "model";
            combinedUserMessage = "";
        } else if (msg.characterId) {
            const otherCharacter = state.characters.find(c => c.id === msg.characterId);
            const characterName = otherCharacter ? otherCharacter.name : "Another character";
            formattedHistory.push({
                role: "user",
                parts: [{ text: `[${characterName}] ${msg.content}` }]
            });
            lastRole = "user";
            combinedUserMessage = "";
        }
    }

    // Ensure history ends with user message if needed
    if (formattedHistory.length > 0 && formattedHistory[formattedHistory.length - 1].role === "model") {
        formattedHistory.push({
            role: "user",
            parts: [{
                text: state.personalContext.name
                    ? `(${state.personalContext.name} continues listening)`
                    : "(continue the conversation)"
            }]
        });
    }

    return formattedHistory; // fixed bug: Error getting character response: TypeError: Assignment to constant variable. at convertHistoryForGemini
    // Error sending message: ReferenceError: typingMsg is not defined at getCharacterResponse
}

// Quick test function to directly open chat window for testing
function forceOpenChat() {
    console.log("Force opening chat window for testing");

    // Create a test character if none exists
    if (state.characters.length === 0) {
        const testCharacter = {
            id: "test-character",
            name: "Test Character",
            userContext: "This is a test character created automatically for testing the chat interface.",
            enhancedContext: null,
            createdAt: new Date().toISOString()
        };
        state.characters.push(testCharacter);
        setStoredItem(STORAGE_KEYS.CHARACTERS, state.characters);
        updateCharacterLists();
    }

    // Select the first character
    state.selectedCharacters = [state.characters[0].id];
    state.activeCharacters = [state.characters[0]];

    // Set active chat
    const chatId = state.selectedCharacters[0];
    state.activeChat = chatId;

    // Ensure chat exists in state
    if (!state.chats[chatId]) {
        state.chats[chatId] = [];
        setStoredItem(STORAGE_KEYS.CHATS, state.chats);
    }

    // Switch to chat view
    changeView('chat');

    // Force UI update directly - don't rely on changeView
    console.log("Directly updating chat UI");

    // Hide placeholder, show chat window
    const placeholder = document.getElementById('chat-placeholder');
    const chatWindow = document.getElementById('chat-window');

    if (placeholder) {
        placeholder.classList.add('hidden');
        console.log("Placeholder hidden");
    } else {
        console.warn("Chat placeholder not found");
    }

    if (chatWindow) {
        chatWindow.classList.remove('hidden');
        console.log("Chat window shown");
    } else {
        console.warn("Chat window not found");
    }

    // Update chat header
    const headerTitle = document.getElementById('chat-header-title');
    if (headerTitle) headerTitle.textContent = state.characters[0].name;

    const headerSubtitle = document.getElementById('chat-header-subtitle');
    if (headerSubtitle) {
        const apiStatus = state.isApiConnected ? `${getProviderDisplayName()} connected` : `${getProviderDisplayName()} not connected`;
        headerSubtitle.textContent = `Conversation - ${apiStatus}`;
    }

    // Add a welcome message based on API status
    let welcomeMessage = "";

    if (state.isApiConnected) {
        welcomeMessage = `Welcome to the chat! ${getProviderDisplayName()} is connected and ready.`;
    } else {
        welcomeMessage = `Welcome to the chat! Configure and test ${getProviderDisplayName()} in Settings to receive AI-generated responses.`;
    }

    // Reset existing messages
    state.chats[chatId] = [];

    const welcomeMsg = {
        id: generateUniqueId(),
        content: welcomeMessage,
        isUser: false,
        characterId: state.characters[0].id,
        timestamp: new Date().toISOString(),
        isDeleted: false,
    };

    // Add message to chat
    addMessage(welcomeMsg);

    // Try to connect API if key exists but connection failed
    if (isProviderConfigured() && !state.isApiConnected) {
        initializeAIProvider().then(success => {
            if (success) {
                // Update header with new status
                if (headerSubtitle) {
                    headerSubtitle.textContent = `Conversation - ${getProviderDisplayName()} connected`;
                }

                // Add a success message
                addMessage({
                    id: generateUniqueId(),
                    content: `${getProviderDisplayName()} connection successful! Your messages will now receive AI-generated responses.`,
                    isUser: false,
                    characterId: state.characters[0].id,
                    timestamp: new Date().toISOString(),
                    isDeleted: false,
                });
            }
        }).catch(error => {
            console.error("Error connecting to API:", error);
        });
    }
}

// API communication
async function callGeminiAPI(prompt) {
    try {
        return await callAIText(prompt, appSettings.enhancedContextTokens || appSettings.maxTokens);
    } catch (error) {
        console.error(`${getProviderDisplayName()} API call failed:`, error);
        state.isApiConnected = false;
        checkApiKey();
        throw error;
    }
}

async function enhanceCharacterContext(characterId) {
    if (!isProviderConfigured()) {
        showError(getProviderConfigurationMessage());
        return;
    }

    const character = state.characters.find(c => c.id === characterId);
    if (!character) {
        showError("Character not found");
        return;
    }

    // Find the enhance button directly - don't rely on previous selectors
    const enhanceButton = document.querySelector(`#enhance-btn-${characterId}`);
    if (enhanceButton) {
        // Visually update the button
        enhanceButton.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i> Enhancing...';
        enhanceButton.disabled = true;
    } else {
        console.warn(`Enhance button for character ${characterId} not found`);
    }

    // Ensure API is initialized
    if (!state.isApiConnected) {
        try {
            const initialized = await initializeGeminiAPI();
            if (!initialized) {
                showError(`Failed to connect to ${getProviderDisplayName()}. Please check your provider settings.`);
                resetEnhanceButton(enhanceButton);
                return;
            }
        } catch (error) {
            showError(`API initialization failed: ${error.message}`);
            resetEnhanceButton(enhanceButton);
            return;
        }
    }

    // Call API
    try {
        const enhancedContext = await callEnhanceAPI(character.name, character.userContext);

        // Update character
        character.enhancedContext = enhancedContext;
        setStoredItem(STORAGE_KEYS.CHARACTERS, state.characters);

        // Show success message
        showSuccess(`Character ${character.name} has been enhanced!`);

        // Update the container of this specific character if it exists
        const characterItem = document.getElementById(`character-item-${characterId}`);
        if (characterItem) {
            // Find or create enhanced context container
            let enhancedContainer = characterItem.querySelector('.enhanced-context');
            if (!enhancedContainer) {
                enhancedContainer = document.createElement('div');
                enhancedContainer.className = 'mt-3 bg-gray-50 p-2 rounded enhanced-context';

                // Insert before the button container
                const buttonContainer = characterItem.querySelector('.mt-3');
                if (buttonContainer) {
                    characterItem.insertBefore(enhancedContainer, buttonContainer);
                } else {
                    characterItem.appendChild(enhancedContainer);
                }
            }

            // Update the content
            enhancedContainer.innerHTML = `
                <p class="text-sm text-gray-700 font-semibold">Enhanced Context:</p>
                <div class="text-gray-600 text-sm mt-1 max-h-60 overflow-auto p-1 border rounded bg-white">
                    ${enhancedContext}
                </div>
            `;

            // Reset the enhance button
            resetEnhanceButton(enhanceButton, "Re-Enhance Context");
        } else {
            // If we can't find the individual item, update the whole list
            const characterListContainer = document.getElementById('character-list');
            if (characterListContainer) {
                characterListContainer.innerHTML = generateCharacterListHTML();
            }
            resetEnhanceButton(enhanceButton);
        }
    } catch (error) {
        console.error("Error enhancing character:", error);
        showError(`Failed to enhance character: ${error.message}`);
        resetEnhanceButton(enhanceButton);
    }
}

// Helper function to reset enhance button
function resetEnhanceButton(button, text = 'Enhance Context') {
    if (button) {
        button.innerHTML = `<i class="fas fa-magic mr-1"></i> ${text}`;
        button.disabled = false;
    }
}

// Success message function
function showSuccess(message, duration = 3000) {
    // Remove any existing success messages
    const existingMessages = document.querySelectorAll('.success-message');
    existingMessages.forEach(msg => msg.remove());

    // Create a new success message element
    const successMessage = document.createElement('div');
    successMessage.className = 'success-message';
    successMessage.innerHTML = `
        <div class="flex items-center justify-between">
            <div class="flex items-center">
                <i class="fas fa-check-circle mr-2"></i>
                <span>${message}</span>
            </div>
            <button class="text-green-800 hover:text-green-900" onclick="this.parentElement.parentElement.remove()">
                <i class="fas fa-times"></i>
            </button>
        </div>
    `;

    // Add to document
    document.body.appendChild(successMessage);

    // Auto-remove after duration
    if (duration > 0) {
        setTimeout(() => {
            if (successMessage.parentNode) {
                successMessage.remove();
            }
        }, duration);
    }
}

async function callEnhanceAPI(characterName, userContext) {
    // Calculate approximate word count based on token limit (0.75 tokens per word)
    const wordLimit = Math.floor(appSettings.enhancedContextTokens * 0.75);

    const prompt = `
You are an expert character developer for roleplaying. Transform this brief character description into a detailed character profile that can guide an AI in consistently roleplaying as this character.
Fill in the details about but dont sound like the character, because this is for generating a character context which will be used to roleplay with the user. Importantly do not have a starting message at
all, like for example Here's a comprehensive character profile of the character, designed to guide..... Do not do that!!!  Just start providing the character profile without any confirmation.
CHARACTER NAME: "${characterName}"

BRIEF DESCRIPTION (that user provided that needs to be enhanced with more critical details):
"${userContext}"

CREATE A COMPREHENSIVE CHARACTER PROFILE INCLUDING:
1. Personality traits with specific behavioral examples
2. Distinctive speech patterns, vocabulary choices, and verbal tics
3. Background information and formative experiences that shaped them
4. Core motivations, values, and life goals
5. Key relationships and how they interact with different types of people
6. Emotional responses to various situations (angry, happy, stressed, etc.)
7. Physical appearance and mannerisms if relevant
8. Skills, knowledge areas, and expertise
9. Fears, insecurities, and internal conflicts

FORMAT AS A COHESIVE PROFILE THAT DEFINES THE CHARACTER'S ESSENCE.
- Make the character feel authentic and three-dimensional with consistent traits.
- Include specific examples of how they would speak and react.
- Write in third person.
- IMPORTANT: Your response MUST be approximately ${wordLimit} words or fewer to fit within the token limit of ${appSettings.enhancedContextTokens} tokens. Focus on depth and specificity rather than length.
`;

    try {
        // Use the regular callGeminiAPI function which already uses appSettings
        const result = await callGeminiAPI(prompt);
        return result;
    } catch (error) {
        console.error("Error enhancing character:", error);
        throw error;
    }
}

function deleteCharacter(characterId) {
    console.log("Deleting character:", characterId);

    // Remove from characters array
    state.characters = state.characters.filter(c => c.id !== characterId);
    setStoredItem(STORAGE_KEYS.CHARACTERS, state.characters);

    // Remove from selected characters
    state.selectedCharacters = state.selectedCharacters.filter(id => id !== characterId);

    // Remove from active characters if present
    if (state.activeCharacters) {
        state.activeCharacters = state.activeCharacters.filter(c => c.id !== characterId);
    }

    // Remove from last active chats
    if (state.lastActiveChats[characterId]) {
        delete state.lastActiveChats[characterId];
        setStoredItem(STORAGE_KEYS.LAST_ACTIVE_CHATS, state.lastActiveChats);
    }

    // Remove associated chats
    let chatsRemoved = 0;
    for (const chatId in state.chats) {
        if (chatId.includes(characterId)) {
            delete state.chats[chatId];
            chatsRemoved++;
        }
    }
    setStoredItem(STORAGE_KEYS.CHATS, state.chats);

    console.log(`Character deleted, removed ${chatsRemoved} associated chats`);

    // Remove the HTML element directly
    const charElement = document.getElementById(`character-item-${characterId}`);
    if (charElement) {
        charElement.remove();
    }

    // Optionally, update the sidebar if needed
    updateSidebarCharacters();

    // Show success message
    showSuccess("Character deleted successfully");

    // Comprehensive UI update
    updateCharacterLists();

    // Make sure we update the chat view too if needed
    if (state.activeChat && state.activeChat.includes(characterId)) {
        // Reset active chat if it contained the deleted character
        state.activeChat = null;
        changeView('chat'); // Force refresh of chat view
    }

    return true;
}

function updateCharacterLists() {
    console.log("Updating character lists with", state.characters.length, "characters");
    if (document.readyState !== 'complete' && document.readyState !== 'interactive') {
        console.log("DOM not ready, deferring character list update");
        document.addEventListener('DOMContentLoaded', updateCharacterLists);
        return;
    }
    try {
        // This part is for the main "Characters" view
        renderFilteredAndSortedCharacters();

        // This updates the sidebar, which has its own sorting logic
        updateSidebarCharacters();

        // If we're in an active chat with no data, reset the active chat
        if (state.activeChat && (!state.chats[state.activeChat] || state.chats[state.activeChat].length === 0)) {
            // Check if any characters in activeChat were deleted
            const chatCharIds = state.activeChat.split('-');
            const allExist = chatCharIds.every(id => state.characters.some(c => c.id === id));

            if (!allExist) {
                // Reset the active chat and update UI
                state.activeChat = null;
                state.activeCharacters = [];
                updateChatUI();
            }
        }
    } catch (error) {
        console.error("Error updating character lists:", error);
        // Try to recover by refreshing the whole page if critical error
        if (error.toString().includes("TypeError")) {
            console.log("Critical error detected, suggesting page refresh");
            showError("An error occurred. Please refresh the page.");
        }
    }
}

// --- Helper function to generate HTML for a single character item ---
// (Adapted from generateCharacterListHTML and setupCharacterItemListeners)
function createCharacterItemHTML(character) {
    // Determine how to display the character avatar
    let avatarHTML = '';
    if (character.profilePicture) {
        avatarHTML = `<img src="${character.profilePicture}" alt="${character.name}" class="w-10 h-10 rounded-full object-cover mr-3">`;
    } else {
        avatarHTML = `<div class="character-avatar bg-primary/20 text-primary mr-3">${character.name.charAt(0).toUpperCase()}</div>`;
    }

    return `
    <div class="border rounded-lg p-4 hover:shadow-md transition" id="character-item-${character.id}">
            <div class="flex justify-between items-start">
                <div class="flex items-center">
                    ${avatarHTML}
                    <h3 class="font-bold text-lg">${character.name}</h3>
                </div>
                <div class="flex space-x-2">
                    <button
                        id="edit-btn-${character.id}"
                        class="text-blue-500 hover:text-blue-700"
                        title="Edit character"
                    >
                        <i class="fas fa-edit"></i>
                    </button>
                    <button
                        id="delete-btn-${character.id}"
                        class="text-red-500 hover:text-red-700"
                        title="Delete character"
                    >
                        <i class="fas fa-trash"></i>
                    </button>
                </div>
            </div>

            <div class="mt-2">
                <p class="text-sm text-gray-700 font-semibold">User-Provided Context:</p>
                <div class="text-gray-600 text-sm mt-1 max-h-32 overflow-auto p-1 border rounded bg-gray-50">
                    ${character.userContext}
                </div>
            </div>

            ${character.enhancedContext ? `
            <div class="mt-3 bg-gray-50 p-2 rounded enhanced-context" id="enhanced-context-${character.id}">
                    <p class="text-sm text-gray-700 font-semibold">Enhanced Context:</p>
                    <div class="text-gray-600 text-sm mt-1 max-h-60 overflow-auto p-1 border rounded bg-white">
                        ${character.enhancedContext}
                    </div>
                </div>
            ` : ''}

            <div class="mt-3 flex justify-center">
                <button
                    id="enhance-btn-${character.id}"
                    class="text-sm bg-secondary text-white px-3 py-1 rounded hover:bg-secondary/90 transition disabled:bg-gray-400"
                ${!isProviderConfigured() ? 'disabled' : ''}
                >
                <i class="fas fa-magic mr-1"></i> ${character.enhancedContext ? 'Re-Enhance Context' : 'Enhance Context'}
                </button>
            </div>
        </div>
    `;
}


// --- Filtering and Sorting Logic ---
function filterCharacters(characters, searchTerm) {
    if (!searchTerm || searchTerm.trim() === "") {
        return characters;
    }
    const lowerSearchTerm = searchTerm.trim().toLowerCase(); // Trim before converting to lowercase
    return characters.filter(character => {
        const nameMatch = character.name ? character.name.toLowerCase().includes(lowerSearchTerm) : false;
        const userContextMatch = character.userContext.toLowerCase().includes(lowerSearchTerm);
        const enhancedContextMatch = character.enhancedContext ? character.enhancedContext.toLowerCase().includes(lowerSearchTerm) : false;
        return nameMatch || userContextMatch || enhancedContextMatch;
    });
}

function sortCharacters(characters, sortOrder) {
    const sorted = [...characters]; // Create a new array to avoid mutating the original
    switch (sortOrder) {
        case "createdAt_desc":
            sorted.sort((a, b) => (b.createdAt ? new Date(b.createdAt).getTime() : 0) - (a.createdAt ? new Date(a.createdAt).getTime() : 0));
            break;
        case "createdAt_asc":
            sorted.sort((a, b) => (a.createdAt ? new Date(a.createdAt).getTime() : 0) - (b.createdAt ? new Date(b.createdAt).getTime() : 0));
            break;
        case "name_asc":
            sorted.sort((a, b) => a.name.localeCompare(b.name));
            break;
        case "name_desc":
            sorted.sort((a, b) => b.name.localeCompare(a.name));
            break;
        case "lastChat_desc":
            sorted.sort((a, b) => {
                const tsA = getLastMessageTimestamp(a.id);
                const tsB = getLastMessageTimestamp(b.id);
                if (tsA === 0 && tsB !== 0) return 1; // Characters with no chats go to the end
                if (tsA !== 0 && tsB === 0) return -1; // Characters with chats come first
                return tsB - tsA; // Sort by most recent message
            });
            break;
    }
    return sorted;
}

// --- Rendering Logic for Main Character List ---
function displayCharactersInMainList(charactersToDisplay) {
    const characterListContainer = document.getElementById('character-list');

    if (!characterListContainer) {
        console.error("Character list container not found!");
        return;
    }

    if (charactersToDisplay.length === 0) {
        let message = "No characters created yet. Create one to get started!";
        if (state.characterSearchTerm && state.characterSearchTerm.trim() !== "") {
            message = "No characters match your search criteria.";
        }
        // Set the innerHTML to the "no characters" message.
        // Ensure the <p> tag has the id 'no-characters' if other parts of the code expect it,
        // though with this direct management, the id might become less critical for this specific function.
        characterListContainer.innerHTML = `<p id="no-characters" class="text-gray-500 italic">${message}</p>`;
    } else {
        // Set the innerHTML to the list of characters.
        // This implicitly removes the "no-characters" paragraph if it was there.
        characterListContainer.innerHTML = charactersToDisplay.map(character => createCharacterItemHTML(character)).join('');

        // Re-attach event listeners for the newly rendered items
        charactersToDisplay.forEach(character => {
            const editBtn = document.getElementById(`edit-btn-${character.id}`);
            if (editBtn) {
                editBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    editCharacter(character.id);
                });
            }
            const deleteBtn = document.getElementById(`delete-btn-${character.id}`);
            if (deleteBtn) {
                deleteBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    deleteCharacter(character.id);
                });
            }
            const enhanceBtn = document.getElementById(`enhance-btn-${character.id}`);
            if (enhanceBtn) {
                enhanceBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    enhanceCharacterContext(character.id);
                });
            }
        });
    }
}


function renderFilteredAndSortedCharacters() {
    // Only render if the characters view is active and visible
    // Also render if the initial load is happening (DOM content loaded)
    const charactersView = document.getElementById('characters-view');
    // We need to render on initial load even if characters view is hidden
    // because the initial view is often chat, but the character list
    // needs to be populated for the filter/sort controls to work correctly
    // if the user switches views later.
    let processedCharacters = [...state.characters];
    processedCharacters = filterCharacters(processedCharacters, state.characterSearchTerm);
    processedCharacters = sortCharacters(processedCharacters, state.characterSortOrder);
    displayCharactersInMainList(processedCharacters);
}

// Save app settings to local storage
function saveAppSettings(options = {}) {
    const { reinitialize = false } = options;
    delete appSettings.allowGroupChats;
    delete appSettings.topK;
    delete appSettings.topP;
    setStoredItem(STORAGE_KEYS.SETTINGS, appSettings);

    if (reinitialize && isProviderConfigured()) {
        console.log("Settings changed, reinitializing provider with new configuration");
        initializeAIProvider().then(success => {
            if (success) {
                showSuccess("Provider settings updated", 2000);
            } else {
                showError("Failed to update provider settings. Please check your configuration.");
            }
        }).catch(error => {
            console.error("Error reinitializing provider:", error);
            showError(`Error updating provider: ${error.message}`);
        });
    }
}
function updateLocalBridgeStatus() {
    const status = document.getElementById('local-bridge-status');
    if (!status) return;

    const bridge = window.__GCRP_LOCAL_AI_BRIDGE__;
    status.className = 'mt-3 text-xs';

    if (bridge?.active) {
        status.classList.add('text-green-600');
        status.textContent = `Bridge status: active in this browser (v${bridge.version || 'unknown'}).`;
        return;
    }

    if (window.location.protocol === 'https:') {
        status.classList.add('text-amber-600');
        status.textContent = 'Bridge status: not detected. Install the userscript before using local models from Netlify or a phone browser.';
        return;
    }

    status.classList.add('text-gray-500');
    status.textContent = 'Bridge status: not detected. This is fine for same-PC localhost use; phones still need a LAN IP endpoint and the bridge.';
}

function updateProviderSettingsVisibility() {
    const provider = getCurrentProvider();
    document.querySelectorAll('[data-provider-settings]').forEach(panel => {
        panel.classList.toggle('hidden', panel.getAttribute('data-provider-settings') !== provider);
    });

    const providerHelp = document.getElementById('provider-help-text');
    if (providerHelp) {
        if (provider === AI_PROVIDERS.GEMINI) {
            providerHelp.textContent = "Uses Google Gemini through your browser. Thinking is minimized automatically where the API supports it; Gemini 3.1 Pro uses the lowest supported level.";
        } else if (provider === AI_PROVIDERS.OLLAMA) {
            providerHelp.textContent = `Uses your local Ollama server. Keep Ollama running and enter an installed model name.${getLocalProviderBridgeHint()}`;
        } else {
            providerHelp.textContent = `Uses LM Studio's local OpenAI-compatible server. Load a model in LM Studio before testing.${getLocalProviderBridgeHint()}`;
        }
    }

    updateLocalBridgeStatus();
}

function markProviderConnectionDirty() {
    state.isApiConnected = false;
    state.activeProvider = null;
    checkApiKey();
}

function saveVisibleProviderSettings() {
    const providerSelect = document.getElementById('provider-select');
    const modelSelect = document.getElementById('model-select');
    const apiKeyInput = document.getElementById('api-key-input');
    const ollamaBaseUrl = document.getElementById('ollama-base-url');
    const ollamaModelInput = document.getElementById('ollama-model-input');
    const lmStudioBaseUrl = document.getElementById('lmstudio-base-url');
    const lmStudioModelInput = document.getElementById('lmstudio-model-input');

    if (providerSelect) appSettings.provider = providerSelect.value;
    if (modelSelect) appSettings.modelVersion = modelSelect.value;
    if (apiKeyInput) state.apiKey = apiKeyInput.value.trim();
    if (ollamaBaseUrl) appSettings.ollamaBaseUrl = ollamaBaseUrl.value.trim() || DEFAULT_OLLAMA_URL;
    if (ollamaModelInput) appSettings.ollamaModel = ollamaModelInput.value.trim();
    if (lmStudioBaseUrl) appSettings.lmStudioBaseUrl = lmStudioBaseUrl.value.trim() || DEFAULT_LM_STUDIO_URL;
    if (lmStudioModelInput) appSettings.lmStudioModel = lmStudioModelInput.value.trim();

    delete appSettings.allowGroupChats;
    delete appSettings.topK;
    delete appSettings.topP;

    setStoredItem(STORAGE_KEYS.API_KEY, state.apiKey);
    saveAppSettings({ reinitialize: false });
}

// Initialize event listeners for model settings
function initializeModelSettings() {
    const providerSelect = document.getElementById('provider-select');
    const modelSelect = document.getElementById('model-select');
    const apiKeyInput = document.getElementById('api-key-input');
    const ollamaBaseUrl = document.getElementById('ollama-base-url');
    const ollamaModelInput = document.getElementById('ollama-model-input');
    const lmStudioBaseUrl = document.getElementById('lmstudio-base-url');
    const lmStudioModelInput = document.getElementById('lmstudio-model-input');
    const temperatureRange = document.getElementById('temperature-range');
    const temperatureValue = document.getElementById('temperature-value');
    const enhancedContextTokens = document.getElementById('enhanced-context-tokens');
    const conversationTokens = document.getElementById('conversation-tokens');
    const testModelBtn = document.getElementById('test-model-btn');

    if (providerSelect) providerSelect.value = getCurrentProvider();
    if (modelSelect) modelSelect.value = getGeminiModelName();
    if (apiKeyInput && state.apiKey) apiKeyInput.value = state.apiKey;
    if (ollamaBaseUrl) ollamaBaseUrl.value = appSettings.ollamaBaseUrl || DEFAULT_OLLAMA_URL;
    if (ollamaModelInput) ollamaModelInput.value = appSettings.ollamaModel || "";
    if (lmStudioBaseUrl) lmStudioBaseUrl.value = appSettings.lmStudioBaseUrl || DEFAULT_LM_STUDIO_URL;
    if (lmStudioModelInput) lmStudioModelInput.value = appSettings.lmStudioModel || "";

    if (temperatureRange && temperatureValue) {
        temperatureRange.value = appSettings.temperature;
        temperatureValue.textContent = appSettings.temperature;
    }

    if (enhancedContextTokens) {
        enhancedContextTokens.value = getTokenLimit(appSettings.enhancedContextTokens, 4096);
    }

    if (conversationTokens) {
        conversationTokens.value = getTokenLimit(appSettings.conversationTokens || appSettings.maxTokens, 4096);
    }

    updateProviderSettingsVisibility();
    window.addEventListener('gcrp-local-ai-bridge-ready', updateProviderSettingsVisibility, { once: true });

    if (providerSelect) {
        providerSelect.addEventListener('change', () => {
            saveVisibleProviderSettings();
            markProviderConnectionDirty();
            updateProviderSettingsVisibility();
        });
    }

    if (modelSelect) {
        modelSelect.addEventListener('change', () => {
            saveVisibleProviderSettings();
            markProviderConnectionDirty();
        });
    }

    [ollamaBaseUrl, ollamaModelInput, lmStudioBaseUrl, lmStudioModelInput].forEach(input => {
        if (!input) return;
        input.addEventListener('change', () => {
            saveVisibleProviderSettings();
            markProviderConnectionDirty();
        });
    });

    if (temperatureRange && temperatureValue) {
        temperatureRange.addEventListener('input', (e) => {
            appSettings.temperature = parseFloat(e.target.value);
            temperatureValue.textContent = e.target.value;
            saveAppSettings({ reinitialize: false });
        });
    }

    if (enhancedContextTokens) {
        enhancedContextTokens.addEventListener('change', (e) => {
            e.target.value = getTokenLimit(e.target.value, 4096);
            appSettings.enhancedContextTokens = parseInt(e.target.value, 10);
            saveAppSettings({ reinitialize: false });
        });
    }

    if (conversationTokens) {
        conversationTokens.addEventListener('change', (e) => {
            e.target.value = getTokenLimit(e.target.value, 4096);
            appSettings.conversationTokens = parseInt(e.target.value, 10);
            appSettings.maxTokens = appSettings.conversationTokens;
            saveAppSettings({ reinitialize: false });
        });
    }

    if (testModelBtn) {
        testModelBtn.addEventListener('click', testModelConfiguration);
    }
}

// Test model configuration
async function testModelConfiguration() {
    const testResult = document.getElementById('test-result');
    const testStatus = document.getElementById('test-status');
    const testDetails = document.getElementById('test-details');
    const testBtn = document.getElementById('test-model-btn');

    if (!testResult || !testStatus || !testDetails || !testBtn) return;

    testResult.classList.remove('hidden', 'bg-green-100', 'bg-red-100');
    testResult.classList.add('bg-blue-100');
    testStatus.textContent = 'Testing configuration...';
    testDetails.textContent = `Connecting to ${getProviderDisplayName()}...`;
    testBtn.disabled = true;

    try {
        saveVisibleProviderSettings();

        if (!isProviderConfigured()) {
            throw new Error(getProviderConfigurationMessage());
        }

        const initialized = await initializeAIProvider();
        if (!initialized) {
            throw new Error(`${getProviderDisplayName()} could not be initialized.`);
        }

        testDetails.textContent = 'Testing model response...';
        const response = await callAIText("Respond with 'Configuration test successful' if you receive this message.", 96);
        const provider = getCurrentProvider();
        const model = provider === AI_PROVIDERS.GEMINI
            ? getGeminiModelName()
            : provider === AI_PROVIDERS.OLLAMA
                ? appSettings.ollamaModel
                : await resolveLMStudioModel();

        testResult.classList.remove('bg-blue-100');
        testResult.classList.add('bg-green-100');
        testStatus.textContent = 'Configuration test successful!';
        testDetails.innerHTML = `
            <div class="space-y-1">
                <p>Provider: ${getProviderDisplayName()}</p>
                <p>Model: ${model}</p>
                <p>Temperature: ${appSettings.temperature}</p>
                <p>Conversation Tokens: ${appSettings.conversationTokens}</p>
                <p>Response received: ${response.substring(0, 80)}...</p>
            </div>
        `;
    } catch (error) {
        testResult.classList.remove('bg-blue-100');
        testResult.classList.add('bg-red-100');
        testStatus.textContent = 'Configuration test failed';
        testDetails.textContent = `Error: ${error.message}`;
        console.error('Model test failed:', error);
    } finally {
        testBtn.disabled = false;
    }
}
// Initialize message delete buttons based on screen size
function initMessageDeleteButtons() {
    // Check if we're on mobile or desktop
    const isMobile = window.innerWidth <= 768;

    // Get all delete buttons
    const deleteButtons = document.querySelectorAll('button[id^="delete-msg-"]');

    // Set initial visibility based on screen size
    deleteButtons.forEach(button => {
        if (isMobile) {
            button.classList.remove('hidden');
        } else {
            button.classList.add('hidden');
        }
    });
}

// Utility function to debounce frequent events like resize
function debounce(func, wait) {
    let timeout;
    return function () {
        const context = this;
        const args = arguments;
        clearTimeout(timeout);
        timeout = setTimeout(() => {
            func.apply(context, args);
        }, wait);
    };
}

// Save personal context
function savePersonalContext() {
    const nameInput = document.getElementById('user-name');
    const personalityInput = document.getElementById('user-personality');
    const contextInput = document.getElementById('user-context');

    // Update state with new values
    state.personalContext = {
        name: nameInput.value.trim(),
        personality: personalityInput.value.trim(),
        context: contextInput.value.trim()
    };

    // Save to storage
    setStoredItem(STORAGE_KEYS.PERSONAL_CONTEXT, state.personalContext);

    // If there's an active chat, update the chat UI to reflect changes
    if (state.activeChat && state.chats[state.activeChat]) {
        // Save current chat to history to preserve context
        saveCurrentChatToHistory();

        // Show success message
        showSuccess("Personal context updated! Changes will be reflected in your next interactions.", 3000);
    } else {
        showSuccess("Personal context saved successfully!", 3000);
    }
}

// Helper function to get last message timestamp for a chat
function getLastMessageTimestamp(characterId) {
    // Find all chats with this character
    const chatsWithCharacter = Object.keys(state.chats).filter(chatId => chatId.includes(characterId));

    if (chatsWithCharacter.length === 0) return 0;

    // Track the latest timestamp found
    let latestTimestamp = 0;

    // Find the most recent message in any chat with this character
    chatsWithCharacter.forEach(chatId => {
        const messages = state.chats[chatId] || [];
        if (messages.length === 0) {
            // Check if this is the active chat - if so, use current time
            if (state.activeChat === chatId) {
                const currentTime = Date.now();
                if (currentTime > latestTimestamp) {
                    latestTimestamp = currentTime;
                }
            }
            return;
        }

        const lastMessage = messages
            .filter(msg => !msg.isDeleted)
            .reverse()
            .find(msg => true); // Get first non-deleted message

        if (lastMessage) {
            const msgTimestamp = new Date(lastMessage.timestamp).getTime();
            if (msgTimestamp > latestTimestamp) {
                latestTimestamp = msgTimestamp;
            }
        }
    });

    // If this character is in the active chat, prioritize it by using current time
    if (state.activeChat && state.activeChat.includes(characterId) && state.activeCharacters.some(c => c.id === characterId)) {
        return Date.now();
    }

    return latestTimestamp;
}

// Function to regenerate the last AI message
async function regenerateMessage(characterId) {
    if (state.isResponseInProgress) {
        showError("Please wait for the current response to finish before regenerating.");
        return;
    }

    if (!state.activeChat || state.activeCharacters.length === 0) {
        showError("No active chat or characters selected");
        return;
    }
    // Get the messages in the current chat
    const messages = state.chats[state.activeChat] || [];
    if (messages.length === 0) return;

    // Find the last message from the specified character
    const characterMessages = messages
        .filter(m => !m.isUser && m.characterId === characterId && !m.isDeleted && !m.isTyping)
        .reverse();

    if (characterMessages.length === 0) return;

    // Get the last message from this character
    const lastMessage = characterMessages[0];

    // Delete the last message
    lastMessage.isDeleted = true;
    setStoredItem(STORAGE_KEYS.CHATS, state.chats);

    // Update UI
    updateChatMessages();

    // Find the character object
    const character = state.characters.find(c => c.id === characterId);
    if (!character) return;

    // Find the message before this one to determine the user message that triggered it
    const messageIndex = messages.findIndex(m => m.id === lastMessage.id);

    // Find the last user message that was sent before this AI message, including continue messages
    let lastUserMsg = null;
    for (let i = messageIndex - 1; i >= 0; i--) {
        if (messages[i].isUser && !messages[i].isDeleted) {
            lastUserMsg = messages[i];
            break;
        }
    }

    // If no user message was found, create a special "regenerate" message
    if (!lastUserMsg) {
        lastUserMsg = {
            id: generateUniqueId(),
            content: "", // Empty content for regeneration
            isUser: true,
            timestamp: new Date().toISOString(),
            isDeleted: true, // Hidden from the UI
            isContinue: true // Treat like a continue message for regeneration
        };
    }

    // Generate a new response
    state.isResponseInProgress = true;
    updateSendButtonState();
    updateChatMessages();

    try {
        await getCharacterResponse(character, lastUserMsg);
    } finally {
        state.isResponseInProgress = false;
        updateSendButtonState();
        updateChatMessages();
    }
}

// After the dismissError function
function editCharacter(characterId) {
    console.log("Editing character:", characterId);

    // Find character in state
    const character = state.characters.find(c => c.id === characterId);
    if (!character) {
        showError("Character not found");
        return;
    }

    // Populate the edit form
    const nameInput = document.getElementById('edit-character-name');
    const contextInput = document.getElementById('edit-character-context');
    const idInput = document.getElementById('edit-character-id');

    if (!nameInput || !contextInput || !idInput) {
        showError("Edit form elements not found");
        return;
    }

    nameInput.value = character.name;
    contextInput.value = character.userContext;
    idInput.value = character.id;

    // Set profile picture if available
    const profilePicturePreview = document.getElementById('edit-profile-picture-preview');
    const removeButton = document.getElementById('edit-remove-profile-picture');

    if (profilePicturePreview) {
        if (character.profilePicture) {
            // Display the existing profile picture
            profilePicturePreview.innerHTML = `<img src="${character.profilePicture}" alt="${character.name}" class="w-full h-full object-cover">`;
            profilePicturePreview.classList.add('has-image');

            // Show the remove button
            if (removeButton) {
                removeButton.classList.remove('hidden');
            }
        } else {
            // Display the default icon
            profilePicturePreview.innerHTML = '<i class="fas fa-user"></i>';
            profilePicturePreview.classList.remove('has-image');

            // Hide the remove button
            if (removeButton) {
                removeButton.classList.add('hidden');
            }
        }
    }

    // Show the edit modal
    const modal = document.getElementById('edit-character-modal');
    if (modal) {
        modal.classList.remove('hidden');
    }
}

function saveEditedCharacter() {
    // Get input fields
    const nameInput = document.getElementById('edit-character-name');
    const contextInput = document.getElementById('edit-character-context');
    const idInput = document.getElementById('edit-character-id');

    if (!nameInput || !contextInput || !idInput) {
        showError("Edit form elements not found");
        return;
    }

    const name = nameInput.value.trim();
    const context = contextInput.value.trim();
    const id = idInput.value;

    // Validate inputs
    if (name === '') {
        showError("Please provide a name for your character");
        nameInput.focus();
        return false;
    }

    if (context === '') {
        showError("Please provide context for your character");
        contextInput.focus();
        return false;
    }

    // Get profile picture if available
    const profilePicturePreview = document.getElementById('edit-profile-picture-preview');
    let profilePicture = null;

    // Check if the preview has an image (not the default icon)
    if (profilePicturePreview && profilePicturePreview.querySelector('img')) {
        // Get the src attribute which contains the base64 data
        profilePicture = profilePicturePreview.querySelector('img').src;
    }

    // Find character in state and update it
    const characterIndex = state.characters.findIndex(c => c.id === id);
    if (characterIndex === -1) {
        showError("Character not found");
        return;
    }

    // Store old name for success message
    const oldName = state.characters[characterIndex].name;
    const oldEnhancedContext = state.characters[characterIndex].enhancedContext; // Store old enhanced context

    // Update character and REMOVE the enhanced context since we've changed the user context
    state.characters[characterIndex].name = name;
    state.characters[characterIndex].userContext = context;
    state.characters[characterIndex].enhancedContext = null; // Clear enhanced context when editing
    state.characters[characterIndex].profilePicture = profilePicture; // Update profile picture

    // IMPORTANT: Update the character in the activeCharacters array as well
    // This ensures the chat immediately uses the new context
    if (state.activeCharacters) {
        const activeCharIndex = state.activeCharacters.findIndex(c => c.id === id);
        if (activeCharIndex !== -1) {
            // Update the active character with the new data
            state.activeCharacters[activeCharIndex] = {
                ...state.characters[characterIndex]
            };
            console.log("Updated active character with new context");
        }
    }

    // If name changed and character is in selected characters, update the chat title
    if (oldName !== name && state.selectedCharacters.includes(id)) {
        updateChatUI();
    }

    // Save to storage
    setStoredItem(STORAGE_KEYS.CHARACTERS, state.characters);

    // Update the specific character element directly for immediate feedback
    const charElement = document.getElementById(`character-item-${id}`);
    if (charElement) {
        // Determine how to display the character avatar
        let avatarHTML = '';
        if (profilePicture) {
            avatarHTML = `<img src="${profilePicture}" alt="${name}" class="w-10 h-10 rounded-full object-cover mr-3">`;
        } else {
            avatarHTML = `<div class="character-avatar bg-primary/20 text-primary mr-3">${name.charAt(0).toUpperCase()}</div>`;
        }

        // Find and update the character header with name and avatar
        const headerElement = charElement.querySelector('.flex.justify-between.items-start');
        if (headerElement) {
            const nameWithAvatarHTML = `
                <div class="flex items-center">
                    ${avatarHTML}
                    <h3 class="font-bold text-lg">${name}</h3>
                </div>
            `;

            // Replace the first child (which should be either the name or the flex container with avatar and name)
            const firstChild = headerElement.firstElementChild;
            if (firstChild) {
                // Create a temporary container
                const temp = document.createElement('div');
                temp.innerHTML = nameWithAvatarHTML.trim();

                // Replace the first child with our new element
                headerElement.replaceChild(temp.firstElementChild, firstChild);
            }
        }

        // Find and update the user context
        const contextElement = charElement.querySelector('.text-gray-600.text-sm.mt-1.max-h-32');
        if (contextElement) {
            contextElement.textContent = context;
        }

        // Remove enhanced context if it exists
        const enhancedContextElement = charElement.querySelector(`#enhanced-context-${id}`);
        if (enhancedContextElement) {
            enhancedContextElement.remove();
        }

        // Update enhance button text (since enhanced context was removed)
        const enhanceBtn = charElement.querySelector(`#enhance-btn-${id}`);
        if (enhanceBtn) {
            enhanceBtn.innerHTML = '<i class="fas fa-magic mr-1"></i> Enhance Context';
        }
    }

    // Update sidebar character for immediate feedback
    const sidebarCharElement = document.getElementById(`sidebar-char-${id}`);
    if (sidebarCharElement) {
        // Update the name
        const sidebarNameElement = sidebarCharElement.querySelector('.text-sm.font-medium');
        if (sidebarNameElement) {
            sidebarNameElement.textContent = name;
        }

        // Update the avatar
        const avatarElement = sidebarCharElement.querySelector('.character-avatar');
        if (avatarElement) {
            if (profilePicture) {
                avatarElement.innerHTML = `<img src="${profilePicture}" alt="${name}" class="w-full h-full object-cover">`;
                avatarElement.classList.add('has-image');
            } else {
                avatarElement.innerHTML = name.charAt(0).toUpperCase();
                avatarElement.classList.remove('has-image');
            }
        }
    }

    // Update UI
    updateSidebarCharacters();
    renderFilteredAndSortedCharacters(); // Re-render the main list if filters/sorts are active

    // Close the modal
    const modal = document.getElementById('edit-character-modal');
    if (modal) {
        modal.classList.add('hidden');
    }

    // Notify in active chat if the character is part of it
    if (state.activeChat && state.activeChat.includes(id)) {
        let notificationContent = `System: ${name}'s context has been updated.`;
        if (oldEnhancedContext) {
            notificationContent += " The character's enhanced context was cleared and may need to be re-generated from the new base context.";
        }
        notificationContent += " The new details will apply to future messages in this chat.";

        const systemMessage = {
            id: generateUniqueId(),
            content: notificationContent,
            isUser: false,
            isSystem: true,
            timestamp: new Date().toISOString(),
            isDeleted: false
        };
        addMessage(systemMessage);
    }

    // Show success message
    showSuccess(`Character "${oldName}" updated to "${name}" successfully!`);
}

function setupEditCharacterModal() {
    // Set up close button
    const closeButton = document.getElementById('close-edit-modal');
    if (closeButton) {
        closeButton.addEventListener('click', () => {
            const modal = document.getElementById('edit-character-modal');
            if (modal) {
                modal.classList.add('hidden');
            }
        });
    }

    // Set up save button
    const saveButton = document.getElementById('save-character-btn');
    if (saveButton) {
        saveButton.addEventListener('click', saveEditedCharacter);
    }

    // Close modal when clicking outside
    const modal = document.getElementById('edit-character-modal');
    if (modal) {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.classList.add('hidden');
            }
        });
    }
}

// Export app data to a JSON file
function exportAppData() {
    try {
        // Collect all data from localStorage
        const appData = {
            apiKey: getStoredItem(STORAGE_KEYS.API_KEY, ""),
            characters: getStoredItem(STORAGE_KEYS.CHARACTERS, []),
            chats: getStoredItem(STORAGE_KEYS.CHATS, {}),
            settings: getStoredItem(STORAGE_KEYS.SETTINGS, {}),
            personalContext: getStoredItem(STORAGE_KEYS.PERSONAL_CONTEXT, {}),
            chatHistory: getStoredItem(STORAGE_KEYS.CHAT_HISTORY, {}),
            lastActiveChats: getStoredItem(STORAGE_KEYS.LAST_ACTIVE_CHATS, {}),
            version: VERSION,
            exportDate: new Date().toISOString()
        };

        // Convert to JSON string
        const jsonData = JSON.stringify(appData, null, 2);

        // Create a Blob with the JSON data
        const blob = new Blob([jsonData], { type: 'application/json' });

        // Create a download link
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');

        // Generate filename with timestamp
        const date = new Date();
        const timestamp = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
        a.href = url;
        a.download = `characterChatBackup_${timestamp}.json`;

        // Trigger download
        document.body.appendChild(a);
        a.click();

        // Clean up
        setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, 100);

        showSuccess("Data exported successfully!", 3000);
    } catch (error) {
        console.error("Error exporting data:", error);
        showError(`Failed to export data: ${error.message}`);
    }
}

// Import app data from a JSON file
function importAppData() {
    // Create a file input element
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.json';

    // Handle file selection
    fileInput.addEventListener('change', (event) => {
        const file = event.target.files[0];
        if (!file) return;

        // Confirm before proceeding
        if (!confirm("Warning: This will replace all your current data including characters, chats, and settings. Are you sure you want to continue?")) {
            return;
        }

        const reader = new FileReader();

        reader.onload = (e) => {
            try {
                // Parse the JSON data
                const importedData = JSON.parse(e.target.result);

                // Validate the imported data
                if (!importedData || typeof importedData !== 'object') {
                    throw new Error("Invalid data format");
                }

                // Store each data type in localStorage
                if (importedData.apiKey !== undefined) {
                    setStoredItem(STORAGE_KEYS.API_KEY, importedData.apiKey);
                }

                if (importedData.characters) {
                    setStoredItem(STORAGE_KEYS.CHARACTERS, importedData.characters);
                }

                if (importedData.chats) {
                    setStoredItem(STORAGE_KEYS.CHATS, importedData.chats);
                }

                if (importedData.settings) {
                    setStoredItem(STORAGE_KEYS.SETTINGS, importedData.settings);
                }

                if (importedData.personalContext) {
                    setStoredItem(STORAGE_KEYS.PERSONAL_CONTEXT, importedData.personalContext);
                }

                if (importedData.chatHistory) {
                    setStoredItem(STORAGE_KEYS.CHAT_HISTORY, importedData.chatHistory);
                }

                if (importedData.lastActiveChats) {
                    setStoredItem(STORAGE_KEYS.LAST_ACTIVE_CHATS, importedData.lastActiveChats);
                }

                // Show success message
                showSuccess("Data imported successfully! Refreshing page...", 2000);

                // Refresh the page after a short delay to show the success message
                setTimeout(() => {
                    window.location.reload();
                }, 2200);
            } catch (error) {
                console.error("Error importing data:", error);
                showError(`Failed to import data: ${error.message}`);
            }
        };

        reader.readAsText(file);
    });

    // Trigger file input click
    fileInput.click();
}

function setupProfilePictureHandlers() {
    // Setup for the create character form
    const profilePictureUpload = document.getElementById('profile-picture-upload');
    const profilePicturePreview = document.getElementById('profile-picture-preview');
    const removeProfilePictureBtn = document.getElementById('remove-profile-picture');

    if (profilePictureUpload && profilePicturePreview) {
        // Handle file selection
        profilePictureUpload.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) {
                // Validate file type
                const validTypes = ['image/jpeg', 'image/png', 'image/webp'];

                // Additional check for GIF files (in case the browser ignores the accept attribute)
                const isGif = file.type === 'image/gif' || file.name.toLowerCase().endsWith('.gif');
                if (isGif) {
                    showError("GIF files are not supported to prevent performance issues. Please use JPG, PNG or WebP instead.");
                    return;
                }

                if (!validTypes.includes(file.type)) {
                    showError("Please select a valid image file (JPG, PNG or WebP only)");
                    return;
                }

                // Validate file size (2MB max)
                const maxSize = 2 * 1024 * 1024; // 2MB in bytes
                if (file.size > maxSize) {
                    showError("Image file is too large. Maximum size is 2MB.");
                    return;
                }

                // Read the file and create a preview
                const reader = new FileReader();
                reader.onload = (event) => {
                    // Create an image element to get dimensions
                    const img = new Image();
                    img.onload = function () {
                        // Check if dimensions are reasonable
                        if (img.width < 50 || img.height < 50) {
                            showError("Image is too small. Minimum dimensions are 50x50 pixels.");
                            return;
                        }

                        // Check for animated PNG (APNG)
                        if (event.target.result.indexOf('ANIM') !== -1 || event.target.result.indexOf('acTL') !== -1) {
                            showError("Animated images are not supported to prevent performance issues. Please use a static image instead.");
                            return;
                        }

                        // Update the preview
                        profilePicturePreview.innerHTML = `<img src="${event.target.result}" alt="Profile Preview" class="w-full h-full object-cover">`;
                        profilePicturePreview.classList.add('has-image');

                        // Show the remove button
                        if (removeProfilePictureBtn) {
                            removeProfilePictureBtn.classList.remove('hidden');
                        }
                    };
                    img.src = event.target.result;
                };
                reader.readAsDataURL(file);
            }
        });

        // Handle remove button click
        if (removeProfilePictureBtn) {
            removeProfilePictureBtn.addEventListener('click', () => {
                // Reset the file input
                profilePictureUpload.value = '';

                // Reset the preview
                profilePicturePreview.innerHTML = '<i class="fas fa-user"></i>';
                profilePicturePreview.classList.remove('has-image');

                // Hide the remove button
                removeProfilePictureBtn.classList.add('hidden');
            });
        }
    }

    // Setup for the edit character modal
    const editProfilePictureUpload = document.getElementById('edit-profile-picture-upload');
    const editProfilePicturePreview = document.getElementById('edit-profile-picture-preview');
    const editRemoveProfilePictureBtn = document.getElementById('edit-remove-profile-picture');

    if (editProfilePictureUpload && editProfilePicturePreview) {
        // Handle file selection
        editProfilePictureUpload.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) {
                // Validate file type
                const validTypes = ['image/jpeg', 'image/png', 'image/webp'];

                // Additional check for GIF files (in case the browser ignores the accept attribute)
                const isGif = file.type === 'image/gif' || file.name.toLowerCase().endsWith('.gif');
                if (isGif) {
                    showError("GIF files are not supported to prevent performance issues. Please use JPG, PNG or WebP instead.");
                    return;
                }

                if (!validTypes.includes(file.type)) {
                    showError("Please select a valid image file (JPG, PNG or WebP only)");
                    return;
                }

                // Validate file size (2MB max)
                const maxSize = 2 * 1024 * 1024; // 2MB in bytes
                if (file.size > maxSize) {
                    showError("Image file is too large. Maximum size is 2MB.");
                    return;
                }

                // Read the file and create a preview
                const reader = new FileReader();
                reader.onload = (event) => {
                    // Create an image element to get dimensions
                    const img = new Image();
                    img.onload = function () {
                        // Check if dimensions are reasonable
                        if (img.width < 50 || img.height < 50) {
                            showError("Image is too small. Minimum dimensions are 50x50 pixels.");
                            return;
                        }

                        // Check for animated PNG (APNG)
                        if (event.target.result.indexOf('ANIM') !== -1 || event.target.result.indexOf('acTL') !== -1) {
                            showError("Animated images are not supported to prevent performance issues. Please use a static image instead.");
                            return;
                        }

                        // Update the preview
                        editProfilePicturePreview.innerHTML = `<img src="${event.target.result}" alt="Profile Preview" class="w-full h-full object-cover">`;
                        editProfilePicturePreview.classList.add('has-image');

                        // Show the remove button
                        if (editRemoveProfilePictureBtn) {
                            editRemoveProfilePictureBtn.classList.remove('hidden');
                        }
                    };
                    img.src = event.target.result;
                };
                reader.readAsDataURL(file);
            }
        });

        // Handle remove button click
        if (editRemoveProfilePictureBtn) {
            editRemoveProfilePictureBtn.addEventListener('click', () => {
                // Reset the file input
                editProfilePictureUpload.value = '';

                // Reset the preview
                editProfilePicturePreview.innerHTML = '<i class="fas fa-user"></i>';
                editProfilePicturePreview.classList.remove('has-image');

                // Hide the remove button
                editRemoveProfilePictureBtn.classList.add('hidden');
            });
        }
    }
}

// Add this near the debounce function
function setupFocusHandling() {
    // Fix for mobile viewport issues - ensures viewport-fit=cover for notches
    const metaViewport = document.querySelector('meta[name=viewport]');
    if (metaViewport) {
        // Ensure width, initial-scale, and viewport-fit are set
        let content = metaViewport.content;
        if (!content.includes("width=device-width")) {
            content += ", width=device-width";
        }
        if (!content.includes("initial-scale=1.0")) {
            content += ", initial-scale=1.0";
        }
        if (!content.includes("viewport-fit=cover")) {
            content += ", viewport-fit=cover";
        }
        // Normalize by removing leading/trailing commas and spaces
        metaViewport.content = content.replace(/^,|,$/g, '').replace(/,\s*,/g, ',').trim();
    }

    const messageInput = document.getElementById('message-input');
    const body = document.body; // Use body from here

    // Detect if we're on iOS for specific resize logic
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;

    if (!messageInput) return;

    // Focus handling function - ensures input is visible when focused
    const handleFocus = () => {
        body.classList.add('keyboard-visible');

        // Set fixed position style for message container to prevent jumping (from old setupMobileViewportFix)
        const messageContainer = document.querySelector('.p-4.bg-white.border-t');
        if (messageContainer) {
            messageContainer.style.zIndex = '1000';
        }

        // Wait for keyboard to appear
        setTimeout(() => {
            // Generic scroll to the input field
            messageInput.scrollIntoView({ block: 'end', behavior: 'smooth' });

            // Scroll to bottom of chat window
            const chatMessages = document.getElementById('chat-messages');
            if (chatMessages) {
                chatMessages.scrollTop = chatMessages.scrollHeight;
            }
        }, 300);
    };

    // Blur handling function - resets when keyboard is hidden
    const handleBlur = () => {
        body.classList.remove('keyboard-visible');
    };

    // Add event listeners
    messageInput.addEventListener('focus', handleFocus);
    messageInput.addEventListener('blur', handleBlur);

    // Setup resize event listener for keyboard detection on Android (non-IOS devices)
    if (!isIOS) {
        const initialHeight = window.innerHeight;
        window.addEventListener('resize', debounce(() => {
            // If height is significantly smaller, keyboard is likely visible
            if (window.innerHeight < initialHeight * 0.75) {
                body.classList.add('keyboard-visible');

                // Adjust messages container position
                setTimeout(() => {
                    if (messageInput) { // Check if messageInput is still valid
                        messageInput.scrollIntoView({ block: 'end', behavior: 'smooth' });
                    }
                }, 100);
            } else {
                body.classList.remove('keyboard-visible');
            }
        }, 100));
    }
}

// Helper function to clean up pending responses and ensure they don't get lost
function cleanupPendingResponses() {
    // Clean up any pending responses that have completed but weren't cleaned properly
    for (const characterId in state.pendingResponses) {
        const pendingData = state.pendingResponses[characterId];
        if (!pendingData.isGenerating) {
            delete state.pendingResponses[characterId];
        }
    }
}
