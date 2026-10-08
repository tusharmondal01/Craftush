# Generate through ChatGPT

Open `/chatgpt/` or choose **Generate in ChatGPT** inside Documentary Studio. This workflow uses Runware’s official OAuth/MCP connection. Runware stores the API key encrypted on its server; ChatGPT stores the OAuth access token. Craftush receives generated results and never receives either credential.

## One-time connection setup

In ChatGPT, open **Plugins → Add → Add custom MCP server**. Create and install two personal connections:

| Name | Server URL | Authentication |
| --- | --- | --- |
| Runware | `https://mcp.runware.ai` | OAuth |
| Craftush | `https://craftush-v13-live.vercel.app/api/chatgpt-mcp` | No authentication |

Review each connection’s permissions. Enter the Runware API key only on Runware’s secure connection page at `mcp.runware.ai`. Do not enter it in Craftush, chat messages, instructions or knowledge files. A workspace must allow personal custom MCP connections. The website provides copy buttons for server URLs and workflow instructions. Craftush also supplies the instructions during MCP initialization and through `craftush_workflow`.

The account owner must complete OAuth credential entry. No key is read from existing website settings or copied into ChatGPT automatically. Existing website generation routes continue to use their original configuration; this separate route needs no provider key on the site.

## Generate and finish

Enter the documentary idea and connect the project in Craftush. In a private ChatGPT Work conversation, select both Runware and Craftush and paste the copied command. Creating a project connection does not start paid generation. The command requests generation using the user’s Runware credits; for planning only, ask “Create only the story plan.”

`craftush_project` prepares each task using `buildDocumentaryTask`: the original master prompt and Claude Fable 5 settings, complete master context and Claude Sonnet 4.6 settings for each director, and PixVerse V6 with native audio, 12 seconds, 720 × 1280, seed 42 and MP4 quality 95. ChatGPT submits the exact native task object with Runware’s `run` tool. Runware manages asynchronous completion. Existing or uncertain tasks are recovered with `get_task_details` and their original UUID. A missing archive result does not prove failure and never triggers an automatic duplicate generation.

ChatGPT records only matching text, video URLs, reported cost, pending status or a confirmed non-secret error. The site refreshes results every ten seconds while visible. Review scenes and select **Open preview & save** when all thirteen are ready. Documentary Studio retains local FFmpeg assembly, music controls, scene downloads and final MP4 preview/download. Imported ChatGPT projects disable website generation; continue their generation in ChatGPT. Regular projects retain their original controls.

ChatGPT runs the sequence during a conversation. It is not an unattended scheduler. If the chat pauses, say **Continue this project** with the same project code. Pending jobs keep their existing UUID. Retry only a confirmed failure after explicitly requesting it, up to three attempts per slot. Model schema incompatibility stops before submission; prompts and settings are never silently reduced. Runware’s public MCP package accepts native task parameters through its `run` tool; authenticated hosted-tool compatibility still needs verification after connection.

## Project access and data

The website generates a random 256-bit code for one project, valid for 24 hours. The private store indexes its SHA-256 hash and does not store the raw code. The code is saved on the current device and supplied to ChatGPT so it can read, prepare and record that temporary project. Anyone holding the code can access it; keep it within the private conversation. **End connection** revokes access without cancelling submitted Runware jobs.

The receiver rejects provider authentication headers and credential fields. Results must match a UUID prepared in that project. Text must pass the original master or scene validation. Videos must be HTTPS Runware video URLs. Repeated completed results are idempotent; conflicting results cannot replace them. Exported project JSON excludes connection codes and provider keys. Creation respects the existing team code and is limited to twenty connections per source IP per hour. Expired projects are inaccessible; saved JSON and downloaded media remain usable.

The MCP server uses the pinned official SDK and stateless Streamable HTTP. It exposes only `craftush_workflow` and `craftush_project`, with project actions limited to read, prepare and record. Creation, revocation and full-project downloads stay on the website. Process project writes sequentially in one conversation. Requests and prepared context have bounded sizes. Download provider media promptly because result URLs expire.

## Verification

`npm run build` restores the exact pinned FFmpeg engine and writes the public workflow instructions. `npm test` checks existing behavior, all thirteen synthetic generation branches, project isolation and expiry, credential rejection, exact request preservation, task reuse, result validation and real official MCP-client initialization, tool discovery and bridge calls. Fixtures do not spend Runware credits. Live generation is tested only after the owner connects Runware and requests generation.

Primary documentation: [Runware MCP](https://runware.ai/docs/tools/mcp), [Runware authentication](https://runware.ai/docs/models-api/authentication), [Runware polling](https://runware.ai/docs/models-api/task-polling), [ChatGPT plugin quickstart](https://developers.openai.com/plugins/quickstart), and [Plugin authentication](https://developers.openai.com/plugins/build/auth).
