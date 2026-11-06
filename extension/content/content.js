
(() => {
    // Prevent the inspector from being installed more than once.
    if (globalThis.__transformerInspectorInstalled) {
        return;
    }

    globalThis.__transformerInspectorInstalled = true;

    // Listen for inspection requests from the popup.
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message?.type !== "INSPECT_PAGE") {
            return;
        }

        try {
            const { blueprint } = globalThis.TransformerInspector.inspect();
            sendResponse({ success: true, data: blueprint });
        } catch (error) {
            console.error("Transformer inspection error:", error);
            sendResponse({ success: false, error: error.message });
        }
    });
})();
