'use client';

import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Terminal, 
  Settings, 
  FolderPlus, 
  ChevronRight,
  CornerDownLeft, 
  Search, 
  Clock,
  PanelLeft,
  PanelRight,
  X
} from 'lucide-react';
import { MOCK_TASKS } from './mock-tasks';

export default function WorkspacePlayground() {
  const [activeTaskId, setActiveTaskId] = useState<string>('onboarding');
  const [inputValue, setInputValue] = useState<string>('');
  const [chatMessages, setChatMessages] = useState<{ sender: 'user' | 'agent'; text: string }[]>([]);
  const [isThinking, setIsThinking] = useState<boolean>(false);
  const [selectedModel] = useState<string>('GPT 5.5');
  const [isLeftSidebarOpen, setIsLeftSidebarOpen] = useState<boolean>(false);
  const [isRightSidebarOpen, setIsRightSidebarOpen] = useState<boolean>(false);

  // Active task details
  const activeTask = MOCK_TASKS[activeTaskId] || MOCK_TASKS['onboarding'];

  // Track expanded files in right review panel
  const [expandedFiles, setExpandedFiles] = useState<Record<string, boolean>>({});

  const handleSelectTask = (taskId: string) => {
    setActiveTaskId(taskId);
    setExpandedFiles({});
  };

  const isFileExpanded = (name: string) => {
    return expandedFiles[name] ?? (name === activeTask.fileName);
  };

  const toggleFileExpanded = (name: string) => {
    setExpandedFiles(prev => ({
      ...prev,
      [name]: !isFileExpanded(name)
    }));
  };

  const getMockDiffForFile = (fileName: string, added: number, removed: number) => {
    return [
      { type: 'neutral' as const, lineNum: 1, code: `// Compiled and synchronized: ${fileName}` },
      { type: 'addition' as const, lineNum: 2, code: `+ // Successfully validated boundaries for ${fileName.split('/').pop()}` },
      { type: 'addition' as const, lineNum: 3, code: `+ const totalLinesAdded = ${added};` },
      { type: 'deletion' as const, lineNum: 4, code: `- const legacyDelta = ${removed};` },
      { type: 'neutral' as const, lineNum: 5, code: `  return { status: "ready" };` }
    ];
  };

  // Handle typing inside the mockup command terminal
  const handleSendMessage = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputValue.trim() || isThinking) return;

    const userText = inputValue;
    setChatMessages(prev => [...prev, { sender: 'user', text: userText }]);
    setInputValue('');
    setIsThinking(true);

    // Simulate Agent Thinking and Response
    setTimeout(() => {
      let agentText = "I have analyzed your code database. Tell me what files you me to update, or select a workspace task on the left to review local diffs.";
      
      const query = userText.toLowerCase();
      if (query.includes('hello') || query.includes('hi')) {
        agentText = "Hello! I am LegionCode's local workspace daemon. Let me know what feature you want to compose or refactor, and I will orchestrate the workspace agent instantly.";
      } else if (query.includes('readme') || query.includes('documentation')) {
        agentText = "I can definitely polish your README.md. Click on the 'Sync Private Alpha README.md' task in the left panel to review how I restructure file configurations!";
      } else if (query.includes('performance') || query.includes('slow') || query.includes('fast') || query.includes('lint') || query.includes('test')) {
        agentText = "Standard run runbooks and boundary validation tests are fully synchronized! Click the 'Run baseline validation gates' task to see how we verify the workspace.";
      } else if (query.includes('model') || query.includes('gemini') || query.includes('llm') || query.includes('brain')) {
        agentText = "LegionCode delegates actions locally using Cloudflare sandboxes. The orchestration engine is housed inside apps/brain.";
      }

      setChatMessages(prev => [...prev, { sender: 'agent', text: agentText }]);
      setIsThinking(false);
    }, 1800);
  };

  return (
    <div id="workspace" className="max-w-5xl mx-auto px-4 sm:px-6 w-full mb-16 relative">
      
      {/* Ambient colored / white glass flow underlays */}
      <div className="absolute -inset-6 bg-gradient-to-tr from-white/5 via-neutral-500/5 to-white/5 rounded-3xl blur-2xl -z-10 opacity-70 pointer-events-none" />
      <div className="absolute top-1/2 -right-12 w-64 h-64 bg-white/5 rounded-full blur-[90px] -z-10 pointer-events-none" />
      <div className="absolute bottom-1/4 -left-12 w-72 h-72 bg-neutral-100/5 rounded-full blur-[100px] -z-10 pointer-events-none" />

      {/* Simulated Window Frame - High-end Frosted Glass UI */}
      <div className="bg-[#0c0c0c]/45 backdrop-blur-2xl border border-white/10 rounded-2xl overflow-hidden shadow-[0_25px_50px_-12px_rgba(0,0,0,0.8)] flex flex-col h-[580px] text-zinc-300 font-sans text-xs">
        
        {/* Custom Window Header Options */}
        <div className="bg-white/[0.04] backdrop-blur-md border-b border-white/5 px-4 py-3 flex items-center justify-between select-none">
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-[#1c1c1c] border border-white/5" />
            <div className="w-3 h-3 rounded-full bg-[#1c1c1c] border border-white/5" />
            <div className="w-3 h-3 rounded-full bg-[#1c1c1c] border border-white/5" />
            <span className="text-zinc-400 ml-4 font-mono select-none">LegionCode — core-terminal</span>
          </div>
          <div className="flex items-center gap-4 text-zinc-500 font-mono text-[10px]">
            <div className="flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-white/40" />
              <span>LOCAL ENGINE v1.2</span>
            </div>
          </div>
        </div>

        {/* Main Interactive Editor Body Pane */}
        <div className="flex-1 flex overflow-hidden min-w-0">
          
          {/* SIDEBAR Panel (Left) */}
          <div className={`w-56 bg-[#0c0c0ced]/95 lg:bg-black/25 backdrop-blur-xl lg:backdrop-blur-md border-r border-white/5 flex flex-col justify-between select-none shrink-0 absolute lg:static inset-y-0 left-0 z-30 transition-transform duration-300 ${isLeftSidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'} lg:flex`}>
            <div className="py-2.5">
              
              {/* Scope Selector block */}
              <div className="px-3.5 mb-3 flex items-center justify-between text-zinc-500 uppercase tracking-wider font-semibold text-[10px]">
                <span>Workspaces</span>
                <Settings className="w-3.5 h-3.5 opacity-60" />
              </div>

              {/* Task Search box */}
              <div className="px-3 mb-4">
                <div className="flex items-center gap-2 bg-white/[0.02] border border-white/5 px-2 py-1.5 rounded-md text-zinc-500 text-[11px]">
                  <Search className="w-3 h-3" />
                  <span>Search task history...</span>
                </div>
              </div>

              {/* Collapsed/Active files tree */}
              <div className="px-1.5 space-y-4">
                {/* First Workspace Block */}
                <div>
                  <div className="px-2 py-1 text-[11px] text-zinc-400 flex items-center gap-1 font-mono select-none">
                    <ChevronRight className="w-3.5 h-3.5 rotate-90 text-zinc-650" />
                    <span>LegionCode/</span>
                  </div>
                  
                  <div className="mt-1 space-y-0.5">
                    <button 
                      onClick={() => {
                        handleSelectTask('onboarding');
                        setIsLeftSidebarOpen(false);
                      }}
                      className={`w-full px-5 py-2 text-left rounded-md flex flex-col gap-0.5 transition-colors ${activeTaskId === 'onboarding' ? 'bg-white/10 text-white border-l-2 border-white' : 'hover:bg-white/[0.03] text-zinc-400'}`}
                    >
                      <span className="font-medium truncate text-xs">Add repository onboarding flow</span>
                      <span className="text-[10px] text-zinc-500 flex items-center gap-1">
                        <Clock className="w-2.5 h-2.5" /> just now
                      </span>
                    </button>

                    <button 
                      onClick={() => {
                        handleSelectTask('execution');
                        setIsLeftSidebarOpen(false);
                      }}
                      className={`w-full px-5 py-2 text-left rounded-md flex flex-col gap-0.5 transition-colors ${activeTaskId === 'execution' ? 'bg-white/10 text-white border-l-2 border-white' : 'hover:bg-white/[0.03] text-zinc-400'}`}
                    >
                      <span className="font-medium truncate text-xs">Polish sandbox execution</span>
                      <span className="text-[10px] text-zinc-500 flex items-center gap-1">
                        <Clock className="w-2.5 h-2.5" /> 15m ago
                      </span>
                    </button>
                  </div>
                </div>

                {/* Second Workspace Block */}
                <div>
                  <div className="px-2 py-1 text-[11px] text-zinc-400 flex items-center gap-1 font-mono select-none">
                    <ChevronRight className="w-3.5 h-3.5 rotate-90 text-zinc-650" />
                    <span>project-alpha/</span>
                  </div>

                  <div className="mt-1 space-y-0.5">
                    <button 
                      onClick={() => {
                        handleSelectTask('readme');
                        setIsLeftSidebarOpen(false);
                      }}
                      className={`w-full px-5 py-2 text-left rounded-md flex flex-col gap-0.5 transition-colors ${activeTaskId === 'readme' ? 'bg-white/10 text-white border-l-2 border-white' : 'hover:bg-white/[0.03] text-zinc-400'}`}
                    >
                      <span className="font-medium truncate text-xs">Sync README.md docs</span>
                      <span className="text-[10px] text-zinc-500 flex items-center gap-1">
                        <Clock className="w-2.5 h-2.5" /> 1h ago
                      </span>
                    </button>
                    
                    <button 
                      onClick={() => {
                        handleSelectTask('verification');
                        setIsLeftSidebarOpen(false);
                      }}
                      className={`w-full px-5 py-2 text-left rounded-md flex flex-col gap-0.5 transition-colors ${activeTaskId === 'verification' ? 'bg-white/10 text-white border-l-2 border-white' : 'hover:bg-white/[0.03] text-zinc-400'}`}
                    >
                      <span className="font-medium truncate text-xs">Run validation gates</span>
                      <span className="text-[10px] text-zinc-500 flex items-center gap-1">
                        <Clock className="w-2.5 h-2.5" /> 3h ago
                      </span>
                    </button>
                  </div>
                </div>

              </div>
            </div>

            {/* Bottom of Sidebar */}
            <div className="p-2 border-t border-white/5 flex flex-col gap-1">
              <button className="flex items-center gap-2 px-2 py-1.5 text-zinc-500 hover:text-white rounded hover:bg-white/[0.03] transition-colors cursor-pointer text-left">
                <FolderPlus className="w-3.5 h-3.5" />
                <span>Add repository</span>
              </button>
              <button className="flex items-center gap-2 px-2 py-1.5 text-zinc-500 hover:text-white rounded hover:bg-white/[0.03] transition-colors cursor-pointer text-left">
                <Settings className="w-3.5 h-3.5" />
                <span>Settings</span>
              </button>
            </div>
          </div>

          {/* CENTER PANEL (Agent Interaction and chat feedback) */}
          <div className="flex-1 flex flex-col min-w-0 bg-white/[0.01] backdrop-blur-lg relative">
            
            {/* Active Ticket Title Top-Bar */}
            <div className="px-4 py-3 bg-white/[0.02] border-b border-white/5 flex items-center justify-between shrink-0 select-none gap-2">
              <div className="flex items-center gap-2 min-w-0">
                {/* Left Sidebar Toggle (Mobile only) */}
                <button 
                  type="button"
                  onClick={() => {
                    setIsLeftSidebarOpen(!isLeftSidebarOpen);
                    setIsRightSidebarOpen(false);
                  }}
                  className="lg:hidden p-1.5 text-zinc-400 hover:text-white bg-white/5 border border-white/10 rounded-md transition-all shrink-0 hover:bg-white/10 flex items-center justify-center"
                  title="Toggle Workspaces"
                >
                  <PanelLeft className="w-4 h-4" />
                </button>

                <span className="font-semibold text-white truncate max-w-[150px] sm:max-w-[280px]">{activeTask.title}</span>
                <span className="text-[10px] text-zinc-400 bg-white/5 border border-white/10 px-1.5 py-0.5 rounded font-mono shrink-0">ACTIVE</span>
              </div>
              
              <div className="flex items-center gap-2 shrink-0">
                {/* Right Sidebar Toggle (Mobile only) */}
                <button 
                  type="button"
                  onClick={() => {
                    setIsRightSidebarOpen(!isRightSidebarOpen);
                    setIsLeftSidebarOpen(false);
                  }}
                  className="lg:hidden p-1.5 text-zinc-400 hover:text-white bg-white/5 border border-white/10 rounded-md transition-all shrink-0 hover:bg-white/10 flex items-center justify-center"
                  title="Toggle Review Diff"
                >
                  <PanelRight className="w-4 h-4" />
                </button>
                
                <span className="text-zinc-500 cursor-pointer hover:text-zinc-300 font-bold px-1 select-none text-sm leading-none">···</span>
              </div>
            </div>

            {/* Mobile sidebar overlay helper */}
            {(isLeftSidebarOpen || isRightSidebarOpen) && (
              <div 
                className="absolute inset-0 bg-black/50 backdrop-blur-[1.5px] z-20 lg:hidden cursor-pointer transition-opacity" 
                onClick={() => {
                  setIsLeftSidebarOpen(false);
                  setIsRightSidebarOpen(false);
                }}
              />
            )}

            {/* Content Stream Scroll Area */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4 no-scrollbar">
              
              {/* Execution Metric duration */}
              <div className="flex items-center gap-2 text-zinc-500 select-none">
                <Clock className="w-3.5 h-3.5 text-zinc-600" />
                <span>Worked for <span className="font-mono text-white font-medium">{activeTask.duration}</span></span>
                <ChevronRight className="w-3.5 h-3.5 text-zinc-700" />
              </div>

              {/* Main Agent Statement Box */}
              <div className="bg-white/5 backdrop-blur-md border border-white/10 p-3.5 rounded-xl space-y-3 shadow-lg shadow-black/30">
                <div className="flex items-center gap-2">
                  <div className="w-5 h-5 rounded bg-white/10 border border-white/10 flex items-center justify-center font-mono font-bold text-[10px] text-white">
                    _&gt;
                  </div>
                  <span className="font-semibold text-white font-mono">LegionCode Workspace Agent</span>
                  <span className="text-[10px] text-zinc-500 ml-auto font-mono">Local Compiler Node</span>
                </div>

                <p className="text-zinc-300 leading-relaxed text-[11px] font-mono">
                  {activeTask.message}
                </p>

                {/* Summary file list indicator */}
                <div className="pt-2 border-t border-white/5 text-[11px] space-y-2">
                  <div className="flex items-center gap-2 text-zinc-400 font-mono text-[10.5px]">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                    <span>{activeTask.filesList ? `${activeTask.filesList.length} files changed` : "1 file changed"}</span>
                    {!activeTask.filesList && (
                      <>
                        <span className="text-zinc-700">|</span>
                        <span className="text-zinc-400 font-sans truncate">{activeTask.fileName}</span>
                      </>
                    )}
                  </div>
                  
                  {/* Metric Diff layout */}
                  <div className="flex flex-col gap-1 w-full font-mono text-[10px]">
                    {activeTask.filesList ? (
                      activeTask.filesList.map((file, idx) => (
                        <div key={idx} className="flex items-center justify-between bg-white/[0.02] hover:bg-white/[0.04] transition-colors px-2.5 py-1 rounded border border-white/5 text-zinc-400 w-full">
                          <span className="truncate pr-4 text-[10.5px] text-zinc-450">{file.name}</span>
                          <div className="flex gap-2.5 shrink-0 font-mono text-[10.5px] font-medium">
                            <span className="text-emerald-500">+{file.added}</span>
                            <span className="text-rose-500">-{file.removed}</span>
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className="flex items-center gap-2 bg-white/5 backdrop-blur-sm px-2 py-1 rounded inline-flex text-zinc-400 border border-white/5">
                        <span>{activeTask.fileName}</span>
                        <span className="text-emerald-500">+{activeTask.changes.added}</span>
                        <span className="text-rose-500">-{activeTask.changes.removed}</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Chat Message Lists */}
              <AnimatePresence initial={false}>
                {chatMessages.map((msg, index) => (
                  <motion.div 
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    key={index}
                    className={`flex gap-3 leading-relaxed ${msg.sender === 'user' ? 'justify-end' : 'justify-start'}`}
                  >
                    {msg.sender !== 'user' && (
                      <div className="w-5 h-5 rounded bg-white/10 border border-white/10 shrink-0 flex items-center justify-center font-mono font-bold text-[10px] text-white">
                        _&gt;
                      </div>
                    )}
                    <div className={`p-3 rounded-xl max-w-[85%] text-[11px] backdrop-blur-md ${msg.sender === 'user' ? 'bg-white/10 text-white border border-white/15' : 'bg-white/5 border border-white/5 text-zinc-300'}`}>
                      {msg.sender === 'user' ? (
                        <p className="font-mono text-zinc-300 select-all">&gt; {msg.text}</p>
                      ) : (
                        <p>{msg.text}</p>
                      )}
                    </div>
                  </motion.div>
                ))}
              </AnimatePresence>

              {/* thinking state placeholder */}
              {isThinking && (
                <div className="flex items-center gap-2 text-zinc-500 italic pl-8 select-none text-[10.5px]">
                  <span className="w-2 h-2 rounded-full bg-white/80 animate-ping" />
                  <span>Workspace compiler thinking...</span>
                </div>
              )}
            </div>

            {/* CHAT INPUT AREA (User interactions terminal) */}
            <form onSubmit={handleSendMessage} className="p-3 border-t border-white/5 shrink-0 bg-[#0d0d0d]/30 backdrop-blur-md">
              <div className="flex flex-col border border-white/10 rounded-xl bg-white/[0.02] backdrop-blur-md focus-within:border-white/20 transition-all shadow-inner">
                
                <input 
                  type="text"
                  className="bg-transparent border-0 px-3 py-2.5 text-[11.5px] outline-none text-white placeholder-zinc-500 w-full font-mono"
                  placeholder="Ask LegionCode anything, @ to add files, / for commands..."
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                />

                <div className="px-2.5 pb-2.5 pt-1.5 flex items-center justify-between select-none">
                  <div className="flex items-center gap-2">
                    <div className="bg-white/5 hover:bg-white/10 px-2.5 py-1 rounded border border-white/10 text-zinc-300 transition-colors text-[10px] flex items-center gap-1.5 cursor-pointer font-mono">
                      <span className="w-1.5 h-1.5 rounded-full bg-white/40" />
                      <span>{selectedModel}</span>
                    </div>
                  </div>

                  <button 
                    type="submit" 
                    className="w-7 h-7 bg-white hover:bg-zinc-105 text-black flex items-center justify-center rounded-md cursor-pointer transition-colors shadow-md"
                  >
                    <CornerDownLeft className="w-3.5 h-3.5" />
                  </button>
                </div>

              </div>
            </form>

          </div>

          {/* RIGHT REVIEW PATH (Detailed lines Code Diff Panel) */}
          <div className={`w-full max-w-full lg:w-80 lg:max-w-none bg-[#0c0c0ced]/95 lg:bg-black/25 backdrop-blur-xl lg:backdrop-blur-md border-l border-white/5 flex flex-col min-w-0 select-none shrink-0 absolute lg:static inset-y-0 right-0 z-30 transition-transform duration-300 ${isRightSidebarOpen ? 'translate-x-0' : 'translate-x-full lg:translate-x-0'} lg:flex`}>
            
            <div className="border-b border-white/5 h-10 flex items-center shrink-0">
              <button 
                onClick={() => setIsRightSidebarOpen(false)}
                className="lg:hidden h-full px-3 flex items-center justify-center text-zinc-400 hover:text-white hover:bg-white/5 border-r border-white/5 shrink-0 transition-colors"
                title="Close Review Panel"
              >
                <X className="w-3.5 h-3.5" />
              </button>

              <button className="flex-1 py-3 text-center border-b border-white text-white font-medium tracking-tight text-[10.5px]">
                REVIEW (3)
              </button>
              <button className="flex-1 py-3 text-center text-zinc-500 hover:text-zinc-300 text-[10.5px]">
                FILE CHANGES (3)
              </button>
              <button className="flex-1 py-3 text-center text-zinc-400 hover:text-white text-[10.5px]">
                FILES
              </button>
            </div>

            <div className="px-3 py-2 bg-white/[0.01] border-b border-white/5 flex items-center justify-between shrink-0 text-zinc-500 font-mono text-[9.5px]">
              <div className="flex items-center gap-1 bg-white/5 border border-white/10 px-1.5 py-0.5 rounded cursor-pointer">
                <span>Git Status</span>
                <ChevronRight className="w-2.5 h-2.5 rotate-90" />
              </div>
              <div className="flex items-center gap-2 font-mono">
                <span className="hover:text-zinc-350 cursor-pointer">Unified</span>
                <span className="opacity-40">/</span>
                <span className="text-white hover:text-opacity-95 cursor-pointer font-bold">Split</span>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto bg-transparent p-2 font-mono text-[10.5px] leading-relaxed no-scrollbar select-all">
              
              <div 
                onClick={() => toggleFileExpanded(activeTask.fileName)}
                className="mb-3 px-2 py-1.5 bg-white/5 rounded border border-white/10 flex items-center justify-between cursor-pointer hover:bg-white/[0.08] transition-colors"
              >
                <span className="text-zinc-305 text-[10px] truncate flex items-center gap-1.5 font-mono">
                  <ChevronRight className={`w-3.5 h-3.5 text-zinc-650 shrink-0 transition-transform ${isFileExpanded(activeTask.fileName) ? 'rotate-90' : ''}`} />
                  {activeTask.fileName}
                </span>
                <span className="text-[10px] shrink-0 font-mono flex items-center gap-1.5 font-semibold">
                  <span className="text-emerald-500">+{activeTask.changes.added}</span>
                  <span className="text-rose-500">-{activeTask.changes.removed}</span>
                </span>
              </div>

              <div className={`space-y-0.5 font-mono ${isFileExpanded(activeTask.fileName) ? '' : 'hidden'}`}>
                {activeTask.diffLines.map((line, idx) => {
                  let lineClass = 'text-zinc-500';
                  let bgClass = '';
                  
                  if (line.type === 'addition') {
                    lineClass = 'text-white font-medium';
                    bgClass = 'bg-white/10 border-l border-white/65 pl-1 py-0.5';
                  } else if (line.type === 'deletion') {
                    lineClass = 'text-zinc-650 line-through';
                    bgClass = 'bg-black/30 pl-1 py-0.5 opacity-30';
                  }

                  return (
                    <div key={idx} className={`flex items-start gap-3 truncate ${bgClass}`}>
                      <span className="w-7 text-right select-none text-zinc-700 text-[9.5px] shrink-0 pt-0.5">
                        {line.lineNum}
                      </span>
                      <span className={`whitespace-pre block truncate ${lineClass}`}>
                        {line.code}
                      </span>
                    </div>
                  );
                })}
              </div>

              {(() => {
                const otherFiles = (activeTask.filesList || []).filter(f => f.name !== activeTask.fileName);
                return otherFiles.map((file, fIdx) => {
                  const expanded = isFileExpanded(file.name);
                  return (
                    <div 
                      key={fIdx} 
                      onClick={() => toggleFileExpanded(file.name)}
                      className={`mt-3 p-2 bg-white/5 rounded border border-white/10 select-none transition-all cursor-pointer grid grid-cols-[1fr_auto] items-center gap-2 ${expanded ? 'opacity-100 border-white/20' : 'opacity-50 hover:opacity-85'}`}
                    >
                      <span className="text-zinc-350 text-[10px] truncate flex items-center gap-1.5 font-mono col-span-1">
                        <ChevronRight className={`w-3.5 h-3.5 text-zinc-600 shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`} />
                        {file.name}
                      </span>

                      <span className="text-[10px] shrink-0 font-mono col-span-1 text-right flex items-center gap-1.5 font-semibold">
                        <span className="text-emerald-500">+{file.added}</span>
                        <span className="text-rose-500">-{file.removed}</span>
                      </span>

                      {expanded && (
                        <div 
                          className="col-span-2 mt-2 pt-2 border-t border-white/5 space-y-0.5 font-mono select-text"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {getMockDiffForFile(file.name, file.added, file.removed).map((line, lIdx) => {
                            let lineClass = 'text-zinc-500';
                            let bgClass = '';
                            if (line.type === 'addition') {
                              lineClass = 'text-white font-medium';
                              bgClass = 'bg-white/10 border-l border-white/65 pl-1 py-0.5';
                            } else if (line.type === 'deletion') {
                              lineClass = 'text-zinc-650 line-through';
                              bgClass = 'bg-black/30 pl-1 py-0.5 opacity-30';
                            }

                            return (
                              <div key={lIdx} className={`flex items-start gap-2.5 truncate ${bgClass}`}>
                                <span className="w-6 text-right select-none text-zinc-700 text-[9px] shrink-0 pt-0.5">
                                  {line.lineNum}
                                </span>
                                <span className={`whitespace-pre block truncate ${lineClass} text-[10px]`}>
                                  {line.code}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                });
              })()}
            </div>

          </div>

        </div>

      </div>
    </div>
  );
}
