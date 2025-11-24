# Coding Agent Chat

Coding Agent Chat is a web-based interface for interacting with an AI coding agent that can create and modify software projects in real time. The app combines a conversational UI with a project explorer, code editor, and live preview of the running project.

## Features

- 🧠 **AI-powered coding chat**
  - Chat-style interface where users describe what they want to build or change.
  - Example prompt buttons to quickly start with common project types (counter app, todo list, weather dashboard, markdown editor).  

- 💼 **Conversation management**
  - “New Chat” resets the conversation and starts a fresh session with the agent.:contentReference[oaicite:0]{index=0}  

- 📁 **Project structure explorer**
  - Right-hand panel displays the current project files as a tree.
  - Click any file to load its contents into the built-in code editor.:contentReference[oaicite:1]{index=1}  

- ✏️ **Inline code editor**
  - Select a file and edit its contents directly in the browser.
  - Save changes back to the backend via a single “Save” button.:contentReference[oaicite:2]{index=2}  

- 🏗 **Build & run controls**
  - Buttons to **Build**, **Run**, **Stop**, and **Restart** the current project.
  - The frontend calls backend endpoints to build and run the project lifecycle.:contentReference[oaicite:3]{index=3}  

- 🔍 **Live preview & console output**
  - Live preview iframe that loads the running project from a local port returned by the backend.
  - Console output area for runtime logs.:contentReference[oaicite:4]{index=4}  

- ⚡ **Quality-of-life details**
  - `Ctrl+Enter`/`Cmd+Enter` to send messages quickly.
  - Toast notifications for success/error states (saving files, build/run status).  
  - Responsive layout: two-column desktop layout, collapses on smaller screens.:contentReference[oaicite:6]{index=6}  

## Tech Stack

- **Frontend**
  - HTML5 + CSS3 layout for a two-panel dashboard UI.  
  - Vanilla JavaScript with a `CodingAgentChat` class managing UI state, events, and API calls.:contentReference[oaicite:8]{index=8}  

- **Backend**
  - **Deno** runtime with a `deno.json` task configuration.
  - `deno task dev` runs the application using `deno run --watch main.ts`.:contentReference[oaicite:9]{index=9}  
  - Uses `@corespeed/zypher` and Deno standard modules (assert, dotenv), plus `rxjs` and `rxjs-for-await` via Deno’s npm compatibility.:contentReference[oaicite:10]{index=10}  

> Note: The backend exposes `/api/*` endpoints for chat, conversations, files, build, and run operations. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for details.

## Getting Started

### Prerequisites

- [Deno](https://deno.land/) installed (version compatible with `deno.json` tasks).
- Modern web browser (Chrome, Edge, Firefox, Safari).

### Installation

```bash
# Clone the repository
git clone <your-repo-url>.git
cd <your-repo-name>

# Install any Deno dependencies (Deno will fetch them automatically on first run)
deno task dev
