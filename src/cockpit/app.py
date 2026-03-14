"""Claude Cockpit — Main Textual application."""

from __future__ import annotations

import asyncio
from pathlib import Path

from rich.markup import escape
from rich.text import Text
from textual import work
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Container, Horizontal, Vertical
from textual.screen import ModalScreen
from textual.widgets import (
    Button,
    Footer,
    Header,
    Input,
    Label,
    RichLog,
    Select,
    Static,
    TabbedContent,
    TabPane,
    Tree,
)
from textual.widgets.tree import TreeNode

from .session import Container as SessionContainer
from .session import Session, SessionState
from .tracking import GlobalUsage, format_cost, format_tokens

MODELS = [
    ("Sonnet 4.6 (fast)", "sonnet"),
    ("Opus 4.6 (powerful)", "opus"),
    ("Haiku 4.5 (cheap)", "haiku"),
]


class NewSessionDialog(ModalScreen[dict | None]):
    """Dialog for creating a new session."""

    BINDINGS = [
        Binding("escape", "cancel", "Cancel"),
    ]

    def __init__(self, containers: list[SessionContainer]):
        super().__init__()
        self.containers = containers

    def compose(self) -> ComposeResult:
        with Container(id="new-session-dialog"):
            with Vertical(id="dialog-box"):
                yield Label("New Session", id="dialog-title")
                yield Label("Name", classes="dialog-label")
                yield Input(
                    placeholder="e.g. debug-auth, feature-xyz",
                    id="session-name-input",
                    classes="dialog-input",
                )
                yield Label("Working Directory", classes="dialog-label")
                yield Input(
                    value=str(Path.cwd()),
                    id="workdir-input",
                    classes="dialog-input",
                )
                yield Label("Model", classes="dialog-label")
                yield Select(MODELS, value="sonnet", id="model-select")
                with Horizontal(id="dialog-buttons"):
                    yield Button("Create", variant="primary", id="create-btn", classes="dialog-btn")
                    yield Button("Cancel", variant="default", id="cancel-btn", classes="dialog-btn")

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "create-btn":
            name = self.query_one("#session-name-input", Input).value or "New Session"
            workdir = self.query_one("#workdir-input", Input).value
            model = self.query_one("#model-select", Select).value
            self.dismiss({"name": name, "working_dir": workdir, "model": model})
        else:
            self.dismiss(None)

    def on_input_submitted(self, event: Input.Submitted) -> None:
        if event.input.id == "session-name-input":
            self.query_one("#workdir-input", Input).focus()
        elif event.input.id == "workdir-input":
            # Trigger create
            name = self.query_one("#session-name-input", Input).value or "New Session"
            workdir = self.query_one("#workdir-input", Input).value
            model = self.query_one("#model-select", Select).value
            self.dismiss({"name": name, "working_dir": workdir, "model": model})

    def action_cancel(self) -> None:
        self.dismiss(None)


class CockpitApp(App):
    """Claude Cockpit — Multi-session Claude Code manager."""

    TITLE = "Claude Cockpit"
    CSS_PATH = "styles/theme.tcss"

    BINDINGS = [
        Binding("ctrl+n", "new_session", "New Session", show=True),
        Binding("ctrl+w", "close_session", "Close Tab", show=True),
        Binding("ctrl+b", "toggle_sidebar", "Sidebar", show=True),
        Binding("ctrl+k", "cancel_request", "Cancel", show=True),
        Binding("escape", "cancel_request", "Cancel", show=False),
        Binding("ctrl+q", "quit", "Quit", show=True),
    ]

    def __init__(self):
        super().__init__()
        self.sessions: dict[str, Session] = {}
        self.containers: list[SessionContainer] = [
            SessionContainer(name="Default", color="#7aa2f7"),
        ]
        self.global_usage = GlobalUsage()
        self._tab_counter = 0
        self._sidebar_visible = True

    def compose(self) -> ComposeResult:
        yield Header()
        with Horizontal(id="app-body"):
            with Vertical(id="sidebar"):
                yield Static(" Sessions", id="sidebar-title")
                tree: Tree[str] = Tree("Containers", id="session-tree")
                tree.root.expand()
                default_node = tree.root.add("Default", expand=True)
                default_node.data = self.containers[0].id
                yield tree
            with Vertical(id="main-content"):
                with TabbedContent(id="tabs"):
                    with TabPane("Welcome", id="tab-welcome"):
                        with Container(id="welcome"):
                            with Vertical(id="welcome-box"):
                                yield Static(
                                    "   Claude Cockpit",
                                    id="welcome-title",
                                )
                                yield Static(
                                    "Multi-session Claude Code manager",
                                    id="welcome-subtitle",
                                )
                                yield Static("")
                                yield Static(
                                    "[bold #7aa2f7]Ctrl+N[/]  Create new session",
                                )
                                yield Static(
                                    "[bold #7aa2f7]Ctrl+B[/]  Toggle sidebar",
                                )
                                yield Static(
                                    "[bold #7aa2f7]Ctrl+W[/]  Close current tab",
                                )
                                yield Static(
                                    "[bold #7aa2f7]Ctrl+K[/]  Cancel running request",
                                )
                                yield Static(
                                    "[bold #7aa2f7]Ctrl+Q[/]  Quit",
                                )
                                yield Static("")
                                yield Static(
                                    "[#565f89]Press Ctrl+N to get started[/]",
                                )
                yield Static("", id="token-bar")
        yield Footer()

    def on_mount(self) -> None:
        self._update_token_bar()

    # ── Actions ──────────────────────────────────────────

    def action_new_session(self) -> None:
        self.push_screen(NewSessionDialog(self.containers), self._on_new_session_result)

    def _on_new_session_result(self, result: dict | None) -> None:
        if result is None:
            return
        session = Session(
            name=result["name"],
            working_dir=result["working_dir"],
            model=result["model"],
            container_id=self.containers[0].id,
        )
        self.sessions[session.id] = session
        self.containers[0].sessions.append(session.id)
        self.global_usage.get_or_create(session.id)

        self._add_session_tab(session)
        self._update_sidebar()

    def _add_session_tab(self, session: Session) -> None:
        """Add a new tab for a session."""
        self._tab_counter += 1
        tab_id = f"tab-{session.id}"

        tabs = self.query_one("#tabs", TabbedContent)

        pane = TabPane(session.name, id=tab_id)
        tabs.add_pane(pane)

        # We need to mount the content after the pane is added
        self.call_after_refresh(self._populate_tab, session, tab_id)

    def _populate_tab(self, session: Session, tab_id: str) -> None:
        """Populate a tab with chat UI after it's mounted."""
        try:
            pane = self.query_one(f"#{tab_id}", TabPane)
        except Exception:
            return

        chat_log = RichLog(
            highlight=True,
            markup=True,
            wrap=True,
            id=f"chat-{session.id}",
            classes="chat-log",
        )
        input_area = Horizontal(id="input-area")

        pane.mount(chat_log)
        pane.mount(input_area)

        prompt_input = Input(
            placeholder=f"Message Claude ({session.model})...",
            id=f"input-{session.id}",
        )
        prompt_input.styles.width = "1fr"
        send_btn = Button("Send", id=f"send-{session.id}", variant="primary")
        send_btn.styles.min_width = 8

        input_area.mount(prompt_input)
        input_area.mount(send_btn)

        # Write welcome message
        chat_log.write(
            Text.from_markup(
                f"[bold #7aa2f7]Session:[/] {session.name}  "
                f"[#565f89]Model:[/] {session.model}  "
                f"[#565f89]Dir:[/] {session.working_dir}"
            )
        )
        chat_log.write(Text.from_markup("[#3b4261]" + "─" * 60 + "[/]"))

        # Focus the input
        tabs.active = tab_id
        self.call_after_refresh(lambda: prompt_input.focus())

    def action_close_session(self) -> None:
        tabs = self.query_one("#tabs", TabbedContent)
        active = tabs.active
        if active and active != "tab-welcome":
            session_id = active.replace("tab-", "")
            if session_id in self.sessions:
                self.sessions[session_id].cancel()
                del self.sessions[session_id]
            tabs.remove_pane(active)
            self._update_sidebar()

    def action_toggle_sidebar(self) -> None:
        sidebar = self.query_one("#sidebar")
        self._sidebar_visible = not self._sidebar_visible
        sidebar.display = self._sidebar_visible

    def action_cancel_request(self) -> None:
        session = self._active_session()
        if session and session.state == SessionState.RUNNING:
            session.cancel()
            chat_log = self._active_chat_log()
            if chat_log:
                chat_log.write(
                    Text.from_markup("[bold #f7768e]Request cancelled.[/]")
                )

    # ── Event handlers ───────────────────────────────────

    def on_input_submitted(self, event: Input.Submitted) -> None:
        input_id = event.input.id or ""
        if input_id.startswith("input-"):
            session_id = input_id.replace("input-", "")
            self._handle_send(session_id)

    def on_button_pressed(self, event: Button.Pressed) -> None:
        btn_id = event.button.id or ""
        if btn_id.startswith("send-"):
            session_id = btn_id.replace("send-", "")
            self._handle_send(session_id)

    def _handle_send(self, session_id: str) -> None:
        session = self.sessions.get(session_id)
        if not session or session.state == SessionState.RUNNING:
            return

        try:
            input_widget = self.query_one(f"#input-{session_id}", Input)
        except Exception:
            return

        prompt = input_widget.value.strip()
        if not prompt:
            return

        input_widget.value = ""

        chat_log = self.query_one(f"#chat-{session_id}", RichLog)

        # Display user message
        chat_log.write(Text(""))
        chat_log.write(
            Text.from_markup(f"[bold #7aa2f7]You:[/]")
        )
        chat_log.write(Text(prompt))

        # Show loading indicator
        chat_log.write(Text(""))
        chat_log.write(
            Text.from_markup("[bold #e0af68]Claude is thinking...[/]")
        )

        self._send_to_claude(session, prompt, session_id)

    @work(thread=True)
    async def _send_to_claude(self, session: Session, prompt: str, session_id: str) -> None:
        """Send message to claude in a background worker."""
        response_parts: list[str] = []

        def on_text(text: str):
            response_parts.append(text)

        def on_tool(tool_info: dict):
            tool_name = tool_info.get("name", "unknown")
            self.call_from_thread(
                self._append_tool_use, session_id, tool_name
            )

        # Run the async send in the worker's event loop
        loop = asyncio.new_event_loop()
        try:
            response = loop.run_until_complete(
                session.send_message(prompt, on_text=on_text, on_tool=on_tool)
            )
        finally:
            loop.close()

        # Update UI from thread
        self.call_from_thread(self._show_response, session_id, response)
        self.call_from_thread(self._update_token_bar)
        self.call_from_thread(self._update_sidebar)

    def _append_tool_use(self, session_id: str, tool_name: str) -> None:
        try:
            chat_log = self.query_one(f"#chat-{session_id}", RichLog)
            chat_log.write(
                Text.from_markup(f"  [#565f89 italic]Using tool: {escape(tool_name)}[/]")
            )
        except Exception:
            pass

    def _show_response(self, session_id: str, response: str) -> None:
        try:
            chat_log = self.query_one(f"#chat-{session_id}", RichLog)
            # Remove the "thinking..." line by writing over it
            chat_log.write(Text(""))
            chat_log.write(
                Text.from_markup("[bold #9ece6a]Claude:[/]")
            )
            # Write response, handling potential markup issues
            for line in response.split("\n"):
                chat_log.write(Text(line))

            # Show usage for this session
            session = self.sessions.get(session_id)
            if session and session.usage.snapshots:
                last = session.usage.snapshots[-1]
                chat_log.write(
                    Text.from_markup(
                        f"[#3b4261]── tokens: {format_tokens(last.input_tokens)} in / "
                        f"{format_tokens(last.output_tokens)} out  "
                        f"cost: {format_cost(last.cost_usd)} ──[/]"
                    )
                )
        except Exception:
            pass

    # ── UI Updates ───────────────────────────────────────

    def _update_token_bar(self) -> None:
        bar = self.query_one("#token-bar", Static)
        total_in = sum(s.usage.total_input for s in self.sessions.values())
        total_out = sum(s.usage.total_output for s in self.sessions.values())
        total_cost = sum(s.usage.total_cost for s in self.sessions.values())
        session_count = len(self.sessions)

        state_counts = {"idle": 0, "running": 0, "error": 0}
        for s in self.sessions.values():
            state_counts[s.state.value] = state_counts.get(s.state.value, 0) + 1

        status_parts = []
        if state_counts["running"]:
            status_parts.append(f"[#e0af68]{state_counts['running']} running[/]")
        if state_counts["error"]:
            status_parts.append(f"[#f7768e]{state_counts['error']} error[/]")

        status = "  ".join(status_parts) if status_parts else ""

        bar.update(
            f" [#737aa2]Tokens:[/] [bold]{format_tokens(total_in)}[/] in / "
            f"[bold]{format_tokens(total_out)}[/] out  "
            f"[#737aa2]Cost:[/] [bold #9ece6a]{format_cost(total_cost)}[/]  "
            f"[#737aa2]Sessions:[/] [bold]{session_count}[/]  {status}"
        )

    def _update_sidebar(self) -> None:
        try:
            tree = self.query_one("#session-tree", Tree)
        except Exception:
            return

        tree.clear()
        for container in self.containers:
            node = tree.root.add(
                f"[bold #bb9af7]{container.name}[/]",
                expand=True,
            )
            node.data = container.id

            for sid in container.sessions:
                session = self.sessions.get(sid)
                if not session:
                    continue

                state_icon = {
                    SessionState.IDLE: "[#9ece6a]\u25cf[/]",
                    SessionState.RUNNING: "[#e0af68]\u25cf[/]",
                    SessionState.ERROR: "[#f7768e]\u25cf[/]",
                }[session.state]

                tokens = format_tokens(session.usage.total_tokens)
                label = f"{state_icon} {session.name} [#565f89]({tokens})[/]"
                leaf = node.add_leaf(label)
                leaf.data = session.id

    def on_tree_node_selected(self, event: Tree.NodeSelected) -> None:
        """Switch to a session tab when clicked in sidebar."""
        node_data = event.node.data
        if node_data and node_data in self.sessions:
            tab_id = f"tab-{node_data}"
            try:
                tabs = self.query_one("#tabs", TabbedContent)
                tabs.active = tab_id
            except Exception:
                pass

    def _active_session(self) -> Session | None:
        tabs = self.query_one("#tabs", TabbedContent)
        active = tabs.active
        if active and active.startswith("tab-"):
            session_id = active.replace("tab-", "")
            return self.sessions.get(session_id)
        return None

    def _active_chat_log(self) -> RichLog | None:
        session = self._active_session()
        if session:
            try:
                return self.query_one(f"#chat-{session.id}", RichLog)
            except Exception:
                pass
        return None
