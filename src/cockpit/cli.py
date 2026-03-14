"""CLI entry point for Claude Cockpit."""


def main():
    from .app import CockpitApp

    app = CockpitApp()
    app.run()


if __name__ == "__main__":
    main()
