class CodingAgentChat {
    constructor() {
        this.currentConversationId = null;
        this.currentProject = null;
        this.currentFile = null;
        this.isRunning = false;
        
        this.initializeEventListeners();
        this.createNewConversation();
    }

    initializeEventListeners() {
        // Chat
        document.getElementById('sendBtn').addEventListener('click', () => this.sendMessage());
        document.getElementById('newChatBtn').addEventListener('click', () => this.createNewConversation());
        document.getElementById('chatInput').addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                this.sendMessage();
            }
        });

        // Example prompts
        document.querySelectorAll('.example-prompt').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const prompt = e.target.getAttribute('data-prompt');
                document.getElementById('chatInput').value = prompt;
            });
        });

        // Project actions
        document.getElementById('buildBtn').addEventListener('click', () => this.buildProject());
        document.getElementById('runBtn').addEventListener('click', () => this.runProject());
        document.getElementById('stopBtn').addEventListener('click', () => this.stopProject());
        document.getElementById('restartBtn').addEventListener('click', () => this.restartProject());

        // Editor
        document.getElementById('saveBtn').addEventListener('click', () => this.saveFile());
        document.getElementById('fileSelector').addEventListener('change', (e) => this.selectFile(e.target.value));

        // Tabs
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                this.switchTab(e.target.getAttribute('data-tab'));
            });
        });
    }

    async createNewConversation() {
        try {
            const response = await fetch('/api/conversations', {
                method: 'POST'
            });
            const result = await response.json();
            
            if (result.success) {
                this.currentConversationId = result.conversation.id;
                this.clearChat();
                this.showWelcomeMessage();
            }
        } catch (error) {
            console.error('Error creating conversation:', error);
        }
    }

    async sendMessage() {
        const chatInput = document.getElementById('chatInput');
        const sendBtn = document.getElementById('sendBtn');
        const loadingSpinner = document.getElementById('loadingSpinner');
        const message = chatInput.value.trim();

        if (!message) return;

        // Add user message to chat
        this.addMessage('user', message);
        chatInput.value = '';

        // Show loading state
        sendBtn.disabled = true;
        loadingSpinner.style.display = 'block';
        sendBtn.querySelector('span').textContent = 'Sending...';

        try {
            const response = await fetch('/api/chat', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    message,
                    conversationId: this.currentConversationId,
                    projectId: this.currentProject?.id
                })
            });

            const result = await response.json();

            if (result.success) {
                // Add assistant message
                this.addMessage('assistant', result.message.content, result.message.files);
                
                // Update project if needed
                if (result.shouldUpdate && result.project) {
                    this.currentProject = result.project;
                    this.updateProjectUI();
                    
                    // Auto-run if it's a new project
                    if (!this.isRunning) {
                        setTimeout(() => this.runProject(), 1000);
                    }
                }
            } else {
                throw new Error(result.error);
            }
        } catch (error) {
            console.error('Error sending message:', error);
            this.addMessage('assistant', `Sorry, I encountered an error: ${error.message}`);
        } finally {
            // Reset loading state
            sendBtn.disabled = false;
            loadingSpinner.style.display = 'none';
            sendBtn.querySelector('span').textContent = 'Send';
            
            // Scroll to bottom after message is added
            this.scrollToBottom();
        }
    }

    addMessage(role, content, files = []) {
        const chatMessages = document.getElementById('chatMessages');
        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${role}`;
        
        let filesHTML = '';
        if (files.length > 0) {
            filesHTML = `
                <div class="message-files">
                    ${files.map(file => `<span class="file-badge">${file}</span>`).join('')}
                </div>
            `;
        }

        messageDiv.innerHTML = `
            <div class="message-content">${this.escapeHtml(content)}</div>
            ${filesHTML}
        `;

        chatMessages.appendChild(messageDiv);
    }

    scrollToBottom() {
        const chatMessages = document.getElementById('chatMessages');
        // Use setTimeout to ensure DOM is updated
        setTimeout(() => {
            chatMessages.scrollTop = chatMessages.scrollHeight;
        }, 100);
    }

    clearChat() {
        document.getElementById('chatMessages').innerHTML = '';
    }

    showWelcomeMessage() {
        const chatMessages = document.getElementById('chatMessages');
        chatMessages.innerHTML = `
            <div class="welcome-message">
                <h3>👋 Welcome to Coding Agent!</h3>
                <p>Describe what you want to build or modify, and I'll help you code it!</p>
                <div class="example-prompts">
                    <div class="example-prompt" data-prompt="Create a simple web server that serves a counter page">
                        Create a counter web app
                    </div>
                    <div class="example-prompt" data-prompt="Build a todo list with add and delete functionality">
                        Build a todo list
                    </div>
                    <div class="example-prompt" data-prompt="Make a weather dashboard that fetches data from an API">
                        Weather dashboard
                    </div>
                    <div class="example-prompt" data-prompt="Create a markdown editor with live preview">
                        Markdown editor
                    </div>
                </div>
            </div>
        `;

        // Re-attach event listeners to example prompts
        document.querySelectorAll('.example-prompt').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const prompt = e.target.getAttribute('data-prompt');
                document.getElementById('chatInput').value = prompt;
            });
        });
    }

    updateProjectUI() {
        const projectActions = document.getElementById('projectActions');
        const fileTree = document.getElementById('fileTree');
        const fileSelector = document.getElementById('fileSelector');

        if (this.currentProject) {
            projectActions.style.display = 'flex';
            
            // Update file tree
            fileTree.innerHTML = this.currentProject.files.map(file => `
                <div class="file-item ${this.currentFile === file.path ? 'active' : ''}" 
                     data-file="${file.path}" 
                     onclick="chat.selectFile('${file.path}')">
                    <span class="file-icon">${this.getFileIcon(file.language)}</span>
                    ${file.name}
                </div>
            `).join('');

            // Update file selector
            fileSelector.innerHTML = `
                <option value="">Select a file to edit</option>
                ${this.currentProject.files.map(file => `
                    <option value="${file.path}" ${this.currentFile === file.path ? 'selected' : ''}>
                        ${file.path}
                    </option>
                `).join('')}
            `;
            fileSelector.style.display = 'block';

            // Update status
            this.updateProjectStatus();
        } else {
            projectActions.style.display = 'none';
            fileTree.innerHTML = '<div class="no-project"><p>No project yet. Start a conversation to create one!</p></div>';
            fileSelector.style.display = 'none';
        }
    }

    getFileIcon(language) {
        const icons = {
            'javascript': '📄',
            'typescript': '📄',
            'python': '🐍',
            'html': '🌐',
            'css': '🎨',
            'json': '⚙️',
            'markdown': '📝'
        };
        return icons[language] || '📄';
    }

    async selectFile(filePath) {
        if (!filePath || !this.currentProject) return;

        this.currentFile = filePath;
        
        // Update UI
        document.querySelectorAll('.file-item').forEach(item => {
            item.classList.remove('active');
        });
        document.querySelector(`.file-item[data-file="${filePath}"]`)?.classList.add('active');
        document.getElementById('fileSelector').value = filePath;

        // Load file content
        try {
            const response = await fetch(`/api/projects/${this.currentProject.id}/files/${encodeURIComponent(filePath)}`);
            const result = await response.json();
            
            if (result.success) {
                const codeEditor = document.getElementById('codeEditor');
                const noFileSelected = document.getElementById('noFileSelected');
                const saveBtn = document.getElementById('saveBtn');
                
                codeEditor.value = result.content;
                codeEditor.style.display = 'block';
                noFileSelected.style.display = 'none';
                saveBtn.style.display = 'block';
            }
        } catch (error) {
            console.error('Error loading file:', error);
        }
    }

    async saveFile() {
        if (!this.currentFile || !this.currentProject) return;

        const codeEditor = document.getElementById('codeEditor');
        const content = codeEditor.value;

        try {
            const response = await fetch(`/api/projects/${this.currentProject.id}/files/${encodeURIComponent(this.currentFile)}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ content })
            });

            const result = await response.json();
            if (result.success) {
                this.showToast('File saved successfully', 'success');
            }
        } catch (error) {
            console.error('Error saving file:', error);
            this.showToast('Error saving file', 'error');
        }
    }

    async buildProject() {
        if (!this.currentProject) return;

        try {
            const response = await fetch(`/api/projects/${this.currentProject.id}/build`, {
                method: 'POST'
            });
            
            const result = await response.json();
            if (result.success) {
                this.showToast('Project built successfully', 'success');
                this.updateProjectStatus();
            }
        } catch (error) {
            console.error('Error building project:', error);
            this.showToast('Error building project', 'error');
        }
    }

    async runProject() {
        if (!this.currentProject) return;

        this.isRunning = true;
        this.updateProjectStatus();

        try {
            const response = await fetch(`/api/projects/${this.currentProject.id}/run`, {
                method: 'POST'
            });
            
            const result = await response.json();
            if (result.success) {
                this.showToast(`Project started on port ${result.port}`, 'success');
                
                // Update preview iframe
                if (result.port) {
                    const previewFrame = document.getElementById('previewFrame');
                    const noPreview = document.getElementById('noPreview');
                    
                    previewFrame.src = `http://localhost:${result.port}`;
                    previewFrame.style.display = 'block';
                    noPreview.style.display = 'none';
                }

                // Start polling for output
                this.startOutputPolling();
            }
        } catch (error) {
            console.error('Error running project:', error);
            this.showToast('Error running project', 'error');
            this.isRunning = false;
            this.updateProjectStatus();
        }
    }

    async stopProject() {
        if (!this.currentProject) return;

        try {
            const response = await fetch(`/api/projects/${this.currentProject.id}/stop`, {
                method: 'POST'
            });
            
            const result = await response.json();
            if (result.success) {
                this.showToast('Project stopped', 'success');
                this.isRunning = false;
                this.updateProjectStatus();
            }
        } catch (error) {
            console.error('Error stopping project:', error);
            this.showToast('Error stopping project', 'error');
        }
    }

    async restartProject() {
        await this.stopProject();
        setTimeout(() => this.runProject(), 1000);
    }

    updateProjectStatus() {
        const runBtn = document.getElementById('runBtn');
        const stopBtn = document.getElementById('stopBtn');
        
        if (this.isRunning) {
            runBtn.style.display = 'none';
            stopBtn.style.display = 'block';
        } else {
            runBtn.style.display = 'block';
            stopBtn.style.display = 'none';
        }
    }

    async startOutputPolling() {
        // Simple output polling
        const outputInterval = setInterval(async () => {
            if (!this.isRunning) {
                clearInterval(outputInterval);
                return;
            }
            
            // In a real implementation, you'd fetch the latest output from the server
            // For now, we'll just keep the interval running
        }, 2000);
    }

    switchTab(tabName) {
        // Update tab buttons
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.classList.remove('active');
        });
        document.querySelector(`.tab-btn[data-tab="${tabName}"]`).classList.add('active');

        // Update tab content
        document.querySelectorAll('.tab-pane').forEach(pane => {
            pane.classList.remove('active');
        });
        document.getElementById(`${tabName}Pane`).classList.add('active');
    }

    showToast(message, type) {
        // Simple toast notification
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.textContent = message;
        toast.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            padding: 12px 20px;
            background: ${type === 'success' ? '#27ae60' : '#e74c3c'};
            color: white;
            border-radius: 6px;
            z-index: 1000;
        `;
        
        document.body.appendChild(toast);
        
        setTimeout(() => {
            toast.remove();
        }, 3000);
    }

    escapeHtml(unsafe) {
        if (!unsafe) return '';
        return unsafe
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;")
            .replace(/\n/g, '<br>');
    }
}

// Initialize the chat when page loads
const chat = new CodingAgentChat();