import {
    CombinedAutocompleteProvider,
    Editor,
    type Component,
    Key,
    Markdown,
    ProcessTerminal,
    ScrollView,
    TuiAltScreen,
    VStack,
    matchesKey,
    truncateToWidth,
    visibleWidth,
} from "@earendil-works/pi-tui";
import type {GexepClientEvent, GexepClientEventListener} from "../a2a/GexepA2AClient.ts";
import {colors, editorTheme, markdownTheme} from "./theme.ts";

export interface GexepClient {
    ask(input: string): Promise<string>;
    setEventListener(listener: GexepClientEventListener | undefined): void;
}

export interface GexepDefinition {
    name: string;
    title: string;
    description: string;
    client: GexepClient;
}

type UiMessageRole = "user" | "assistant" | "notice" | "error";

interface UiMessage {
    role: UiMessageRole;
    text: string;
    agentName?: string;
}

function padToWidth(text: string, width: number): string {
    const clipped = truncateToWidth(text, Math.max(0, width), "");
    return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

class Header implements Component {
    invalidate(): void {}

    render(width: number): string[] {
        if (width < 2) {
            return [""];
        }

        const title = colors.bold(colors.brightCyan(" PANTHEON OF CONFIDANTS "));
        const subtitle = colors.muted(" Gexep A2A 客户端 · 每一位 Agent，都是一位挚友 ");
        const divider = colors.dim("─".repeat(width));
        return [padToWidth(title, width), padToWidth(subtitle, width), divider];
    }
}

class ConversationView implements Component {
    private messages: UiMessage[] = [];

    setMessages(messages: UiMessage[]): void {
        this.messages = [...messages];
    }

    invalidate(): void {}

    render(width: number): string[] {
        if (width <= 0) {
            return [];
        }

        const lines: string[] = [];
        for (const message of this.messages) {
            if (lines.length > 0) {
                lines.push("");
            }
            lines.push(truncateToWidth(` ${this.renderLabel(message)}`, width, ""));

            const defaultColor = message.role === "error"
                ? colors.red
                : message.role === "notice"
                    ? colors.muted
                    : colors.white;
            const markdown = new Markdown(
                message.text,
                Math.min(2, Math.max(0, Math.floor((width - 1) / 2))),
                0,
                markdownTheme,
                {color: defaultColor},
            );
            lines.push(...markdown.render(width));
        }
        return lines.length > 0 ? lines : [colors.muted("  暂无消息")];
    }

    private renderLabel(message: UiMessage): string {
        if (message.role === "user") {
            return colors.bold(colors.blue("YOU"));
        }
        if (message.role === "assistant") {
            return colors.bold(colors.violet(message.agentName ?? "AGENT"));
        }
        if (message.role === "error") {
            return colors.bold(colors.red("ERROR"));
        }
        return colors.bold(colors.muted("PANTHEON"));
    }
}

class ActivityLine implements Component {
    private readonly frames = ["✦", "✧", "◆", "◇"];
    private frame = 0;
    private timer: ReturnType<typeof setInterval> | undefined;
    private active = false;
    private text = "就绪";

    constructor(private readonly requestRender: () => void) {}

    set(text: string, active = false): void {
        this.text = text;
        this.active = active;
        if (active && this.timer === undefined) {
            this.timer = setInterval(() => {
                this.frame = (this.frame + 1) % this.frames.length;
                this.requestRender();
            }, 140);
        } else if (!active) {
            this.stopTimer();
        }
        this.requestRender();
    }

    dispose(): void {
        this.stopTimer();
    }

    invalidate(): void {}

    render(width: number): string[] {
        const icon = this.active ? colors.cyan(this.frames[this.frame] ?? "✦") : colors.green("●");
        const shortcuts = colors.dim("  Enter 发送 · Shift+Enter 换行 · /help 帮助");
        return [truncateToWidth(` ${icon} ${this.text}${shortcuts}`, width, "")];
    }

    private stopTimer(): void {
        if (this.timer !== undefined) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }
}

export class PantheonApp {
    private readonly tui = new TuiAltScreen(
        new ProcessTerminal(),
        true,
        undefined,
        {
            mouse: true,
            scrollToEndIndicator: () => colors.cyan(" ↓ 回到最新消息 "),
            searchMatchStyle: (text) => colors.underline(colors.amber(text)),
            searchCurrentMatchStyle: (text) => colors.bold(colors.amber(text)),
        },
    );
    private readonly editor = new Editor(this.tui, editorTheme, {paddingX: 1});
    private readonly conversationView = new ConversationView();
    private readonly activityLine = new ActivityLine(() => this.tui.requestRender());
    private readonly messages: UiMessage[] = [];
    private busy = false;
    private stopped = false;

    constructor(private readonly definition: GexepDefinition) {
        const transcript = new ScrollView(this.conversationView, {
            follow: "end",
            primary: true,
            scrollbar: "auto",
            scrollbarTrackStyle: colors.dim,
            scrollbarThumbStyle: colors.cyan,
        });
        const root = new VStack([
            {component: new Header(), basis: 3, shrink: 0},
            {component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1},
            {component: this.activityLine, basis: 1, shrink: 0},
            {component: this.editor, basis: "auto", shrink: 0, maxSize: 10},
        ]);

        this.tui.setLayoutRoot(root);
        this.editor.setAutocompleteProvider(new CombinedAutocompleteProvider([
            {name: "help", description: "显示命令与快捷键"},
            {name: "clear", description: "清空当前界面消息"},
            {name: "quit", description: "退出 Pantheon"},
        ], process.cwd()));
        this.editor.onSubmit = (text) => {
            void this.submit(text);
        };

        this.tui.addInputListener((data) => {
            if (matchesKey(data, Key.ctrl("c"))) {
                this.stop();
                return {consume: true};
            }
            if (matchesKey(data, Key.ctrl("l")) && !this.busy) {
                this.clearConversation();
                return {consume: true};
            }
            return undefined;
        });
        this.showConversation();
    }

    start(): void {
        this.tui.setFocus(this.editor);
        this.tui.start();
    }

    stop(): void {
        if (this.stopped) {
            return;
        }
        this.stopped = true;
        this.activityLine.dispose();
        this.definition.client.setEventListener(undefined);
        this.tui.stop();
    }

    private async submit(rawText: string): Promise<void> {
        const text = rawText.trim();
        if (!text || this.busy) {
            return;
        }

        this.editor.addToHistory(text);
        if (text.startsWith("/")) {
            this.handleCommand(text);
            return;
        }

        this.messages.push({role: "user", text});
        this.conversationView.setMessages(this.messages);
        this.setBusy(true);
        this.definition.client.setEventListener((event) => this.handleAgentEvent(event));
        try {
            await this.definition.client.ask(text);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (!this.messages.some((item) => item.role === "error" && item.text === message)) {
                this.messages.push({role: "error", text: message});
            }
        } finally {
            this.definition.client.setEventListener(undefined);
            this.setBusy(false);
            this.conversationView.setMessages(this.messages);
            this.tui.requestRender();
        }
    }

    private handleAgentEvent(event: GexepClientEvent): void {
        switch (event.type) {
            case "start":
                this.activityLine.set("正在连接 Gexep…", true);
                break;
            case "status":
                this.activityLine.set(event.text, true);
                break;
            case "message":
                this.messages.push({role: "assistant", text: event.text, agentName: this.definition.name});
                this.conversationView.setMessages(this.messages);
                this.activityLine.set(`${this.definition.name} 正在完成回复…`, true);
                break;
            case "complete":
                this.activityLine.set(`${this.definition.name} 已就绪`);
                break;
            case "error":
                this.messages.push({role: "error", text: event.error.message});
                this.conversationView.setMessages(this.messages);
                this.activityLine.set("请求失败");
                break;
        }
        this.tui.requestRender();
    }

    private handleCommand(commandLine: string): void {
        const [command = ""] = commandLine.slice(1).trim().split(/\s+/);
        switch (command.toLowerCase()) {
            case "help":
                this.messages.push({
                    role: "notice",
                    text: [
                        "**可用命令**",
                        "",
                        "- `/clear`：清空当前客户端界面（不会删除后端历史）",
                        "- `/quit`：退出界面",
                        "- `Ctrl+L`：快速清屏",
                        "- `Ctrl+C`：退出界面",
                    ].join("\n"),
                });
                this.showConversation();
                break;
            case "clear":
                this.clearConversation();
                break;
            case "quit":
            case "exit":
                this.stop();
                break;
            default:
                this.messages.push({
                    role: "error",
                    text: `未知命令：/${command}。输入 \`/help\` 查看可用命令。`,
                });
                this.showConversation();
        }
    }

    private clearConversation(): void {
        this.messages.length = 0;
        this.showConversation();
    }

    private showConversation(): void {
        if (this.messages.length === 0) {
            this.messages.push({
                role: "notice",
                text: `你正在通过 A2A 与 **${this.definition.name}** 对话。${this.definition.title}：${this.definition.description}`,
            });
        }
        this.conversationView.setMessages(this.messages);
        this.tui.requestRender();
    }

    private setBusy(busy: boolean): void {
        this.busy = busy;
        this.editor.disableSubmit = busy;
        if (!busy) {
            this.activityLine.set(`${this.definition.name} 已就绪`);
        }
        this.tui.requestRender();
    }
}
