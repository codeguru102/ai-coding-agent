import { Application, Router, send } from "https://deno.land/x/oak@v12.6.1/mod.ts";
import {
  AnthropicModelProvider,
  createZypherContext,
  ZypherAgent,
} from "@corespeed/zypher";
import { eachValueFrom } from "rxjs-for-await";

// Project and conversation storage
interface Project {
  id: string;
  name: string;
  description: string;
  language: string;
  status: 'created' | 'building' | 'running' | 'error' | 'stopped';
  created: string;
  path: string;
  files: ProjectFile[];
  currentFile?: string;
  lastOutput?: string;
  port?: number;
}

interface ProjectFile {
  name: string;
  path: string;
  content: string;
  language: string;
}

interface Conversation {
  id: string;
  messages: Message[];
  created: string;
}

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  files?: string[];
}

let projects: Project[] = [];
let conversations: Conversation[] = [];
let currentConversationId: string | null = null;
let nextPort = 3001;

// Load environment variables
async function loadEnv() {
  try {
    const envContent = await Deno.readTextFile('.env');
    const env: Record<string, string> = {};
    envContent.split('\n').forEach(line => {
      const [key, value] = line.split('=');
      if (key && value) {
        env[key.trim()] = value.trim();
      }
    });
    return env;
  } catch {
    return {};
  }
}

const env = await loadEnv();

function getRequiredEnv(name: string): string {
  const value = Deno.env.get(name) || env[name];
  if (!value) {
    throw new Error(`Environment variable ${name} is not set`);
  }
  return value;
}


class CodingAgentService {
  private agent: ZypherAgent | null = null;
  private runningProcesses: Map<string, Deno.ChildProcess> = new Map();

  async initialize() {
    try {
      const zypherContext = await createZypherContext(Deno.cwd(), {
        zypherDir: `${Deno.cwd()}/.zypher`,
        cacheDir: `${Deno.cwd()}/.zypher/cache`,
      });

      this.agent = new ZypherAgent(
        zypherContext,
        new AnthropicModelProvider({
          apiKey: getRequiredEnv("ANTHROPIC_API_KEY"),
          defaultOptions: {
            timeout: 180000,
            maxTokens: 8192,
          },
        }),
      );

      console.log("Coding Agent initialized successfully");
    } catch (error) {
      console.error("Failed to initialize Coding Agent:", error);
    }
  }

  async processChatMessage(prompt: string, currentProject?: Project): Promise<{response: string, files: ProjectFile[], shouldUpdate: boolean}> {
    if (!this.agent) {
      throw new Error("Coding Agent not initialized");
    }

    let context = "";
    if (currentProject) {
      context = `
CURRENT PROJECT: ${currentProject.name}
PROJECT LANGUAGE: ${currentProject.language}
EXISTING FILES:
${currentProject.files.map(f => `- ${f.path} (${f.language})`).join('\n')}

`;
    }

    const enhancedPrompt = `${context}USER REQUEST: ${prompt}

INSTRUCTIONS:
1. Understand the user's request in the context of their current project
2. If this is a code modification request, provide the updated files
3. Format code changes using markdown code blocks with file paths
4. If creating new files, include complete file content
5. If modifying existing files, show the entire updated file
6. Provide clear explanations of what you changed and why

RESPONSE FORMAT:
[Your response explaining the changes]

Files to update:

\`\`\`[language]:[file path]
[complete file content]
\`\`\`

\`\`\`[language]:[file path]
[complete file content]
\`\`\`

[Continue for all modified/created files]`;

    let rawResponse = "";
    try {
      const event$ = this.agent.runTask(enhancedPrompt, "claude-sonnet-4-20250514");

      for await (const event of eachValueFrom(event$)) {
        if (event.type === 'text') {
          rawResponse += event.content;
        }
      }
    } catch (error) {
      console.error("Error during chat processing:", error);
      throw error;
    }

    // Parse files from response
    const files = this.parseFilesFromResponse(rawResponse);
    const shouldUpdate = files.length > 0;
    
    // Extract just the text response (without code blocks)
    const textResponse = this.extractTextResponse(rawResponse);

    return {
      response: textResponse,
      files,
      shouldUpdate
    };
  }

  private parseFilesFromResponse(response: string): ProjectFile[] {
    const files: ProjectFile[] = [];
    const filePattern = /```(\w+)?:?(.*?)\n([\s\S]*?)```/g;
    let match;
    
    while ((match = filePattern.exec(response)) !== null) {
      const language = match[1] || 'text';
      const filePath = match[2].trim();
      const fileContent = match[3].trim();
      
      if (filePath && fileContent) {
        files.push({
          name: filePath.split('/').pop() || filePath,
          path: filePath,
          content: fileContent,
          language: this.normalizeLanguage(language)
        });
      }
    }

    return files;
  }

  private extractTextResponse(response: string): string {
    // Remove code blocks to get just the text explanation
    return response.replace(/```[\s\S]*?```/g, '').trim();
  }

  private normalizeLanguage(lang: string): string {
    const langMap: Record<string, string> = {
      'js': 'javascript',
      'javascript': 'javascript',
      'ts': 'typescript',
      'typescript': 'typescript',
      'py': 'python',
      'python': 'python',
      'json': 'json',
      'html': 'html',
      'css': 'css',
      'md': 'markdown'
    };
    return langMap[lang.toLowerCase()] || 'text';
  }

  async createOrUpdateProject(files: ProjectFile[], prompt: string, existingProject?: Project): Promise<Project> {
    let project: Project;
    
    if (existingProject) {
      console.log(`Updating existing project: ${existingProject.name}`);
      project = existingProject;
      
      // Update files
      for (const newFile of files) {
        const existingFileIndex = project.files.findIndex(f => f.path === newFile.path);
        if (existingFileIndex >= 0) {
          project.files[existingFileIndex] = newFile;
        } else {
          project.files.push(newFile);
        }
        
        // Write file to disk
        const fullPath = `${project.path}/${newFile.path}`;
        const dirPath = fullPath.substring(0, fullPath.lastIndexOf('/'));
        
        try {
          await Deno.mkdir(dirPath, { recursive: true });
          await Deno.writeTextFile(fullPath, newFile.content);
          console.log(`Updated file: ${newFile.path}`);
        } catch (error) {
          console.error(`Error updating file ${newFile.path}:`, error);
        }
      }
    } else {
      // Create new project
      const projectId = generateId();
      const projectPath = `./projects/${projectId}`;
      const projectName = this.generateProjectName(prompt);
      
      try {
        await Deno.mkdir(projectPath, { recursive: true });
      } catch (error) {
        console.error("Error creating project directory:", error);
        throw error;
      }

      // Write all files to disk
      for (const file of files) {
        const fullPath = `${projectPath}/${file.path}`;
        const dirPath = fullPath.substring(0, fullPath.lastIndexOf('/'));
        
        try {
          await Deno.mkdir(dirPath, { recursive: true });
          await Deno.writeTextFile(fullPath, file.content);
        } catch (error) {
          console.error(`Error writing file ${file.path}:`, error);
        }
      }

      project = {
        id: projectId,
        name: projectName,
        description: `Project generated from: ${prompt}`,
        language: this.detectPrimaryLanguage(files),
        status: 'created',
        created: new Date().toISOString(),
        path: projectPath,
        files
      };

      projects.unshift(project);
    }

    return project;
  }

  private generateProjectName(prompt: string): string {
    return prompt.split(' ').slice(0, 3).join('-').toLowerCase().replace(/[^a-z0-9-]/g, '') || 'new-project';
  }

  private detectPrimaryLanguage(files: ProjectFile[]): string {
    const languages = files.map(f => f.language);
    if (languages.includes('typescript')) return 'typescript';
    if (languages.includes('javascript')) return 'javascript';
    if (languages.includes('python')) return 'python';
    return 'javascript';
  }

  async buildProject(projectId: string): Promise<string> {
    const project = projects.find(p => p.id === projectId);
    if (!project) {
      throw new Error('Project not found');
    }

    project.status = 'building';
    
    try {
      let output = '';
      
      if (project.language === 'javascript' || project.language === 'typescript') {
        const packageJsonPath = `${project.path}/package.json`;
        try {
          await Deno.stat(packageJsonPath);
          console.log("Installing npm dependencies...");
          
          // Use shell to run npm install (more reliable)
          const installProcess = new Deno.Command(Deno.build.os === "windows" ? "cmd" : "sh", {
            args: Deno.build.os === "windows" ? ["/c", "npm install"] : ["-c", "npm install"],
            cwd: project.path,
            stdout: 'piped',
            stderr: 'piped'
          });
          
          const { stdout, stderr, success } = await installProcess.output();
          const stdoutText = new TextDecoder().decode(stdout);
          const stderrText = new TextDecoder().decode(stderr);
          
          output += stdoutText;
          if (stderrText) {
            output += `\nSTDERR: ${stderrText}`;
          }
          
          if (success) {
            output += '\n✅ Dependencies installed successfully\n';
          } else {
            output += '\n❌ Dependency installation failed\n';
          }
        } catch (error) {
          output += `ℹ️ No package.json found or npm not available: ${error.message}\n`;
        }
      } else if (project.language === 'python') {
        const requirementsPath = `${project.path}/requirements.txt`;
        try {
          await Deno.stat(requirementsPath);
          console.log("Installing Python dependencies...");
          
          const installProcess = new Deno.Command(Deno.build.os === "windows" ? "cmd" : "sh", {
            args: Deno.build.os === "windows" ? ["/c", "pip install -r requirements.txt"] : ["-c", "pip install -r requirements.txt"],
            cwd: project.path,
            stdout: 'piped',
            stderr: 'piped'
          });
          
          const { stdout, stderr } = await installProcess.output();
          output += new TextDecoder().decode(stdout);
          output += new TextDecoder().decode(stderr);
          output += '\n✅ Python dependencies installed successfully\n';
        } catch {
          output += 'ℹ️ No requirements.txt found\n';
        }
      }
      
      project.status = 'created';
      return output || '✅ Build completed (no dependencies to install)';
    } catch (error) {
      project.status = 'error';
      output += `\n❌ Build error: ${error.message}\n`;
      throw new Error(output);
    }
  }

  async runProject(projectId: string): Promise<{output: string, port?: number}> {
    const project = projects.find(p => p.id === projectId);
    if (!project) {
      throw new Error('Project not found');
    }

    // Stop if already running
    if (this.runningProcesses.has(projectId)) {
      await this.stopProject(projectId);
    }

    project.status = 'running';
    const port = nextPort++;
    project.port = port;

    try {
      let command: string[];
      let args: string[] = [];

      if (project.language === 'javascript') {
        // Try to run with npm start, fallback to node
        const packageJsonPath = `${project.path}/package.json`;
        try {
          await Deno.stat(packageJsonPath);
          command = [Deno.build.os === "windows" ? "cmd" : "sh"];
          args = Deno.build.os === "windows" ? ["/c", "npm start"] : ["-c", "npm start"];
        } catch {
          // Fallback to direct node execution
          const mainFile = project.files.find(f => f.name.includes('index') || f.name.includes('main')) || project.files[0];
          command = ["node"];
          args = [mainFile?.path || 'index.js'];
        }
      } else if (project.language === 'typescript') {
        command = ["deno"];
        args = ["run", "--allow-net", "index.ts"];
      } else if (project.language === 'python') {
        command = ["python"];
        args = ["main.py"];
      } else {
        const mainFile = project.files.find(f => f.name.includes('index') || f.name.includes('main'));
        command = ["node"];
        args = [mainFile?.path || 'index.js'];
      }

      console.log(`Running project with command: ${command} ${args.join(' ')}`);
      
      const process = new Deno.Command(command[0], {
        args: args,
        cwd: project.path,
        stdout: 'piped',
        stderr: 'piped',
        env: {
          ...Deno.env.toObject(),
          PORT: port.toString()
        }
      }).spawn();

      this.runningProcesses.set(projectId, process);

      // Start capturing output in background
      this.captureProcessOutput(projectId, process);

      // Wait a bit for process to start
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      const output = `✅ Project started on port ${port}\nCommand: ${command} ${args.join(' ')}`;
      project.lastOutput = output;
      
      return { output, port };
      
    } catch (error) {
      project.status = 'error';
      throw error;
    }
  }

  private async captureProcessOutput(projectId: string, process: Deno.ChildProcess) {
    const project = projects.find(p => p.id === projectId);
    if (!project) return;

    try {
      // Capture stdout
      const stdoutReader = process.stdout.getReader();
      const stderrReader = process.stderr.getReader();
      
      const readStream = async (reader: ReadableStreamDefaultReader<Uint8Array>, isError = false) => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            
            const output = new TextDecoder().decode(value);
            if (project.lastOutput) {
              project.lastOutput += output;
            } else {
              project.lastOutput = output;
            }
            console.log(`[${project.name}${isError ? ' ERROR' : ''}] ${output}`);
          }
        } catch (error) {
          console.error('Error reading process output:', error);
        }
      };

      // Read both stdout and stderr concurrently
      Promise.all([
        readStream(stdoutReader),
        readStream(stderrReader, true)
      ]).catch(console.error);
      
    } catch (error) {
      console.error('Error setting up output capture:', error);
    }
  }

  async stopProject(projectId: string): Promise<string> {
    const project = projects.find(p => p.id === projectId);
    if (!project) {
      throw new Error('Project not found');
    }

    const process = this.runningProcesses.get(projectId);
    if (process) {
      try {
        process.kill('SIGTERM');
        await process.status;
        this.runningProcesses.delete(projectId);
      } catch (error) {
        console.error('Error stopping process:', error);
      }
    }

    project.status = 'stopped';
    return 'Project stopped';
  }

  async getFileContent(projectId: string, filePath: string): Promise<string> {
    const project = projects.find(p => p.id === projectId);
    if (!project) {
      throw new Error('Project not found');
    }

    try {
      return await Deno.readTextFile(`${project.path}/${filePath}`);
    } catch (error) {
      throw new Error(`File not found: ${filePath}`);
    }
  }

  async updateFileContent(projectId: string, filePath: string, content: string): Promise<void> {
    const project = projects.find(p => p.id === projectId);
    if (!project) {
      throw new Error('Project not found');
    }

    const fullPath = `${project.path}/${filePath}`;
    await Deno.writeTextFile(fullPath, content);

    // Update in-memory file content
    const file = project.files.find(f => f.path === filePath);
    if (file) {
      file.content = content;
    }
  }
}

function generateId(): string {
  return Math.random().toString(36).substr(2, 9);
}

const codingAgent = new CodingAgentService();
await codingAgent.initialize();

// Web Server
const app = new Application();
const router = new Router();

// CORS middleware
app.use(async (ctx, next) => {
  ctx.response.headers.set("Access-Control-Allow-Origin", "*");
  ctx.response.headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  ctx.response.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  
  if (ctx.request.method === "OPTIONS") {
    ctx.response.status = 200;
    return;
  }
  
  await next();
});

// API Routes
router
  .get("/api/conversations", (ctx) => {
    ctx.response.body = conversations;
  })
  .post("/api/conversations", (ctx) => {
    const conversation: Conversation = {
      id: generateId(),
      messages: [],
      created: new Date().toISOString()
    };
    conversations.unshift(conversation);
    currentConversationId = conversation.id;
    ctx.response.body = { success: true, conversation };
  })
  .get("/api/conversations/:id", (ctx) => {
    const conversation = conversations.find(c => c.id === ctx.params.id);
    if (conversation) {
      ctx.response.body = conversation;
    } else {
      ctx.response.status = 404;
      ctx.response.body = { error: "Conversation not found" };
    }
  })
  .post("/api/chat", async (ctx) => {
    try {
      const body = await ctx.request.body().value;
      const { message, conversationId, projectId } = body;

      if (!message) {
        ctx.response.status = 400;
        ctx.response.body = { error: "Message is required" };
        return;
      }

      let conversation = conversations.find(c => c.id === conversationId);
      if (!conversation) {
        conversation = {
          id: generateId(),
          messages: [],
          created: new Date().toISOString()
        };
        conversations.unshift(conversation);
      }

      // Add user message
      const userMessage: Message = {
        id: generateId(),
        role: 'user',
        content: message,
        timestamp: new Date().toISOString()
      };
      conversation.messages.push(userMessage);

      // Get current project if exists
      const currentProject = projectId ? projects.find(p => p.id === projectId) : undefined;

      // Process with AI
      const { response, files, shouldUpdate } = await codingAgent.processChatMessage(message, currentProject);

      let updatedProject = currentProject;
      if (shouldUpdate && files.length > 0) {
        updatedProject = await codingAgent.createOrUpdateProject(files, message, currentProject);
      }

      // Add assistant message
      const assistantMessage: Message = {
        id: generateId(),
        role: 'assistant',
        content: response,
        timestamp: new Date().toISOString(),
        files: files.map(f => f.path)
      };
      conversation.messages.push(assistantMessage);

      ctx.response.body = {
        success: true,
        message: assistantMessage,
        project: updatedProject,
        shouldUpdate: shouldUpdate
      };

    } catch (error) {
      console.error("Error processing chat:", error);
      ctx.response.status = 500;
      ctx.response.body = { error: error.message };
    }
  })
  .get("/api/projects", (ctx) => {
    ctx.response.body = projects;
  })
  .post("/api/projects/:id/build", async (ctx) => {
    try {
      const projectId = ctx.params.id;
      const output = await codingAgent.buildProject(projectId);
      
      ctx.response.body = {
        success: true,
        output,
        projects
      };
    } catch (error) {
      ctx.response.status = 500;
      ctx.response.body = { error: error.message };
    }
  })
  .post("/api/projects/:id/run", async (ctx) => {
    try {
      const projectId = ctx.params.id;
      const result = await codingAgent.runProject(projectId);
      
      ctx.response.body = {
        success: true,
        ...result,
        projects
      };
    } catch (error) {
      ctx.response.status = 500;
      ctx.response.body = { error: error.message };
    }
  })
  .post("/api/projects/:id/stop", async (ctx) => {
    try {
      const projectId = ctx.params.id;
      const output = await codingAgent.stopProject(projectId);
      
      ctx.response.body = {
        success: true,
        output,
        projects
      };
    } catch (error) {
      ctx.response.status = 500;
      ctx.response.body = { error: error.message };
    }
  })
  .get("/api/projects/:id/files/:filePath", async (ctx) => {
    try {
      const projectId = ctx.params.id;
      const filePath = decodeURIComponent(ctx.params.filePath);
      const content = await codingAgent.getFileContent(projectId, filePath);
      
      ctx.response.body = {
        success: true,
        content
      };
    } catch (error) {
      ctx.response.status = 500;
      ctx.response.body = { error: error.message };
    }
  })
  .put("/api/projects/:id/files/:filePath", async (ctx) => {
    try {
      const body = await ctx.request.body().value;
      const projectId = ctx.params.id;
      const filePath = decodeURIComponent(ctx.params.filePath);
      const { content } = body;
      
      await codingAgent.updateFileContent(projectId, filePath, content);
      
      ctx.response.body = {
        success: true
      };
    } catch (error) {
      ctx.response.status = 500;
      ctx.response.body = { error: error.message };
    }
  })
  .delete("/api/projects/:id", (ctx) => {
    const projectId = ctx.params.id;
    projects = projects.filter(project => project.id !== projectId);
    codingAgent.stopProject(projectId).catch(console.error);
    ctx.response.body = { success: true, projects };
  });

// Serve static files
app.use(async (ctx, next) => {
  try {
    await send(ctx, ctx.request.url.pathname, {
      root: `${Deno.cwd()}/static`,
      index: "index.html",
    });
  } catch {
    await next();
  }
});

app.use(router.routes());
app.use(router.allowedMethods());

console.log("🚀 Coding Agent Chat starting on http://localhost:8000");

await app.listen({ port: 8000 });
