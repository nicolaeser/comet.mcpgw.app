export interface CDPTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
  devtoolsFrontendUrl?: string;
}

export interface CDPVersion {
  Browser: string;
  "Protocol-Version": string;
  "User-Agent": string;
  webSocketDebuggerUrl: string;
}

export interface NavigateResult {
  frameId: string;
  loaderId?: string;
  errorText?: string;
}

export interface ScreenshotResult {
  data: string;
}

export interface EvaluateResult {
  result: {
    type: string;
    value?: unknown;
    description?: string;
    objectId?: string;
  };
  exceptionDetails?: {
    text: string;
    exception?: { description?: string };
  };
}

export interface CometState {
  connected: boolean;
  currentUrl?: string;
  activeTabId?: string;
}

export type CometMode = "search" | "research" | "labs" | "learn";

export interface AgentStatus {
  status: "idle" | "working" | "completed";
  steps: string[];
  currentStep: string;
  response: string;
  hasStopButton: boolean;
  agentBrowsingUrl: string;
}
