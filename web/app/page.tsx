'use client';

import { useState, useRef, useEffect } from 'react';
import styles from './page.module.css';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  interactive?: any; // Add interactive payload type
}

type TestContextType = 'client' | 'lead' | 'user';
type StaffRoleName = 'No Access' | 'Some Access' | 'Full Access';

type TestOptionKey = 'client' | 'lead' | 'staff_full' | 'staff_some' | 'staff_none';

interface ContextOption {
  key: TestOptionKey;
  type: TestContextType;
  staffRole?: StaffRoleName;
  label: string;
}

const CONTEXT_OPTIONS: ContextOption[] = [
  { key: 'client', type: 'client', label: 'Client' },
  { key: 'lead', type: 'lead', label: 'Lead' },
  { key: 'staff_full', type: 'user', staffRole: 'Full Access', label: 'Staff — Full' },
  { key: 'staff_some', type: 'user', staffRole: 'Some Access', label: 'Staff — Some' },
  { key: 'staff_none', type: 'user', staffRole: 'No Access', label: 'Staff — None' },
];

const WELCOME_MESSAGES: Record<TestContextType, { greeting: string; suggestions: { label: string; message: string }[] }> = {
  client: {
    greeting: `Hi there! 👋 I'm the TTT Tax Assistant — here to help you manage your tax affairs.\n\nAs a registered TTT client, here's what I can do for you:\n\n• View your *invoices* and *outstanding balance*\n• Check the status of your *tax cases*\n• Look up your *tax number*\n• Request a *callback* from your consultant\n• *Upload documents* (IRP5s, bank statements, etc.)\n• *Refer a friend* to TTT\n\nHow can I help you today?`,
    suggestions: [
      { label: 'My invoices', message: 'Can I see my invoices?' },
      { label: 'My cases', message: 'What is the status of my cases?' },
      { label: 'Upload a document', message: 'I need to upload a document' },
    ],
  },
  lead: {
    greeting: `Welcome to TTT! 👋 I'm the TTT Tax Assistant.\n\nIt looks like you're in the process of becoming a TTT client — that's great! I'm here to help you get set up.\n\nHere's what I can help with right now:\n\n• *Upload your onboarding documents* (ID, payslips, bank statements, tax certificates)\n• Answer questions about *what documents you need*\n• Explain *how the onboarding process works*\n• Tell you about *TTT's services and what to expect*\n\nOnce you're a registered client, you'll have full access to invoice lookups, case tracking, consultant callbacks, and more.\n\nWhat would you like to start with?`,
    suggestions: [
      { label: 'What docs do I need?', message: 'What documents do I need to provide?' },
      { label: 'Upload a document', message: 'I want to upload a document' },
      { label: 'How does onboarding work?', message: 'How does the onboarding process work?' },
    ],
  },
  user: {
    greeting: `Hey! 👋 TTT Staff Assistant here, ready to help.\n\nAs a TTT team member, you have access to:\n\n• *Search for clients* by name or phone number\n• *View any client's invoices* and *cases*\n• *Create new cases* for clients\n• *Create new leads* (prospects)\n• *Upload documents* on behalf of clients\n\nWhat do you need to look up?`,
    suggestions: [
      { label: 'Search a client', message: 'I need to look up a client' },
      { label: 'Create a case', message: 'I need to create a new case' },
      { label: 'Create a lead', message: 'I want to create a new lead' },
    ],
  },
};

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [testOption, setTestOption] = useState<TestOptionKey>('client');
  const selectedOption = CONTEXT_OPTIONS.find(o => o.key === testOption)!;
  const testContext: TestContextType = selectedOption.type;
  const [needsNewSession, setNeedsNewSession] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const switchContext = (key: TestOptionKey) => {
    setTestOption(key);
    setMessages([]);
    setInput('');
    setNeedsNewSession(true);
  };

  const sendMessage = async () => {
    if (!input.trim() || isLoading) return;

    const userMessage = input.trim();
    setInput('');
    setMessages((prev) => [...prev, { role: 'user', content: userMessage }]);
    setIsLoading(true);

    try {
      const response = await fetch('http://localhost:3001/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: userMessage, testOverride: { type: testContext, staffRole: selectedOption.staffRole, newSession: needsNewSession } }),
      });
      if (needsNewSession) setNeedsNewSession(false);

      const data = await response.json();

      if (response.ok) {
        setMessages((prev) => [...prev, { role: 'assistant', content: data.response, interactive: data.interactive }]);
        // If there's a follow-up message (e.g. sign-up link), add it as a separate message
        if (data.followUp) {
          setMessages((prev) => [...prev, { role: 'assistant', content: data.followUp }]);
        }
      } else {
        setMessages((prev) => [...prev, { role: 'assistant', content: 'Error: ' + (data.error || 'Failed to get response') }]);
      }
    } catch (error) {
      setMessages((prev) => [...prev, { role: 'assistant', content: 'Error: Could not connect to server. Make sure the backend is running on port 3001.' }]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const renderFormattedMessage = (content: string) => {
    // Split by newlines to handle paragraphs
    const lines = content.split('\n');

    return lines.map((line, i) => (
      <div key={i} style={{ minHeight: line.trim() === '' ? '1rem' : 'auto' }}>
        {line.split(/(\*[^*]+\*|\[[^\]]+\]\([^)]+\)|https?:\/\/[^\s]+)/g).map((part, j) => {
          // Check if part matches *bold* pattern
          if (part.startsWith('*') && part.endsWith('*') && part.length > 2) {
            return <strong key={j}>{part.slice(1, -1)}</strong>;
          }
          // Check if part matches [text](url) pattern
          const linkMatch = part.match(/\[([^\]]+)\]\(([^)]+)\)/);
          if (linkMatch) {
            return (
              <a
                key={j}
                href={linkMatch[2]}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  color: '#00a884',
                  textDecoration: 'underline',
                  fontWeight: 500
                }}
              >
                {linkMatch[1]}
              </a>
            );
          }
          // Check if part is a bare URL
          if (/^https?:\/\/[^\s]+$/.test(part)) {
            return (
              <a
                key={j}
                href={part}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  color: '#00a884',
                  textDecoration: 'underline',
                  fontWeight: 500
                }}
              >
                {part}
              </a>
            );
          }
          return <span key={j}>{part}</span>;
        })}
      </div>
    ));
  };

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <div className={styles.logo}>
          <span className={styles.logoIcon}>🇿🇦</span>
          <h1>TTT Tax Bot</h1>
        </div>
        <p className={styles.subtitle}>Your South African Tax Assistant</p>
      </header>

      <div className={styles.contextSwitcher}>
        {CONTEXT_OPTIONS.map(({ key, type, label }) => (
          <button
            key={key}
            className={`${styles.contextPill} ${testOption === key ? styles[`contextPill_${type}`] : ''}`}
            onClick={() => switchContext(key)}
          >
            {label}
          </button>
        ))}
      </div>

      <main className={styles.chatContainer}>
        <div className={`${styles.contextBanner} ${styles[`contextBanner_${testContext}`]}`}>
          Testing as: {selectedOption.label}
        </div>
        <div className={styles.messages}>
          {messages.length === 0 && (
            <div className={styles.welcome}>
              <div className={styles.welcomeIcon}>🇿🇦</div>
              <h2>TTT Tax Bot</h2>
              <p>Say hi to get started!</p>
              <div className={styles.suggestions}>
                {WELCOME_MESSAGES[testContext].suggestions.map((s) => (
                  <button key={s.label} onClick={() => setInput(s.message)}>
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((msg, idx) => (
            <div
              key={idx}
              className={`${styles.message} ${msg.role === 'user' ? styles.userMessage : styles.botMessage}`}
            >
              <div className={styles.messageContent}>
                {msg.role === 'assistant' && <span className={styles.botAvatar}>🤖</span>}
                <div className={styles.messageText}>
                  {renderFormattedMessage(msg.content)}

                  {/* Render Interactive Buttons */}
                  {msg.interactive && msg.interactive.type === 'button' && (
                    <div className={styles.interactiveButtons} style={{ marginTop: '10px', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                      {msg.interactive.action.buttons?.map((btn: any) => (
                        <button
                          key={btn.reply.id}
                          style={{
                            padding: '8px 16px',
                            backgroundColor: '#fff',
                            border: '1px solid #00a884',
                            borderRadius: '20px',
                            color: '#00a884',
                            cursor: 'pointer',
                            fontWeight: 600,
                            fontSize: '0.9rem'
                          }}
                          onClick={() => {
                            if (!isLoading) {
                              setInput(btn.reply.title);
                              sendMessage(); // Immediately send the button title as a message
                              // Ideally we should trigger sendMessage directly with value, but this is a quick hack for the UI loop
                              // Actually, better to call sendMessage with the value directly
                              // Let's simplify: Just set input and let user send? No, better UX is auto send.
                              // We need to modify sendMessage to accept an argument.

                              // Direct send simulation:
                              setMessages((prev) => [...prev, { role: 'user', content: btn.reply.title }]);
                              setIsLoading(true);
                              fetch('http://localhost:3001/api/chat', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ message: btn.reply.title, testOverride: { type: testContext, staffRole: selectedOption.staffRole } }),
                              })
                                .then(res => res.json())
                                .then(data => {
                                  setMessages((prev) => [...prev, { role: 'assistant', content: data.response, interactive: data.interactive }]);
                                  setIsLoading(false);
                                })
                                .catch(() => setIsLoading(false));
                            }
                          }}
                        >
                          {btn.reply.title}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}

          {isLoading && (
            <div className={`${styles.message} ${styles.botMessage}`}>
              <div className={styles.messageContent}>
                <span className={styles.botAvatar}>🤖</span>
                <div className={styles.typing}>
                  <span></span>
                  <span></span>
                  <span></span>
                </div>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        <div className={styles.inputContainer}>
          <div className={styles.uploadContainer}>
            <input
              type="file"
              id="fileUpload"
              style={{ display: 'none' }}
              onChange={async (e) => {
                if (e.target.files && e.target.files[0]) {
                  const file = e.target.files[0];
                  const formData = new FormData();
                  formData.append('file', file);
                  // Must match the senderNumber the chat route builds, which
                  // appends -{role_lowercase_underscored} for staff sessions.
                  // Otherwise peekPendingUpload looks under the wrong key.
                  const roleSuffix = testContext === 'user' && selectedOption.staffRole
                      ? `-${selectedOption.staffRole.toLowerCase().replace(/ /g, '_')}`
                      : '';
                  formData.append('phoneNumber', `0832852913-${testContext}${roleSuffix}`);

                  setIsLoading(true);
                  setMessages(prev => [...prev, { role: 'user', content: `[Uploading ${file.name}...]` }]);

                  try {
                    // Step 1: Upload file (stored pending classification)
                    const uploadRes = await fetch('http://localhost:3001/api/upload', {
                      method: 'POST',
                      body: formData
                    });

                    if (!uploadRes.ok) {
                      const data = await uploadRes.json();
                      setMessages(prev => [...prev, { role: 'assistant', content: `Upload failed: ${data.error}` }]);
                      setIsLoading(false);
                      return;
                    }

                    // Step 2: Tell the chat AI a file was uploaded so it asks for classification.
                    // Pass newSession flag so this turn is part of the same session as
                    // whatever conversation is already on screen. Crucially, also reset the
                    // flag afterwards — otherwise the NEXT typed message will still think it
                    // needs a fresh session and nuke the context we just established here
                    // (which is what broke the "upload LoE → bot asks which lead → user
                    // replies 'rosie'" flow).
                    const chatRes = await fetch('http://localhost:3001/api/chat', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ message: `I just uploaded a document: ${file.name}`, testOverride: { type: testContext, staffRole: selectedOption.staffRole, newSession: needsNewSession } }),
                    });
                    if (needsNewSession) setNeedsNewSession(false);
                    const chatData = await chatRes.json();
                    if (chatRes.ok) {
                      setMessages(prev => [...prev, { role: 'assistant', content: chatData.response, interactive: chatData.interactive }]);
                    }
                  } catch (err) {
                    setMessages(prev => [...prev, { role: 'assistant', content: `Upload Error` }]);
                  } finally {
                    setIsLoading(false);
                    // Reset file input
                    e.target.value = '';
                  }
                }
              }}
            />
            <label htmlFor="fileUpload" className={styles.uploadButton} title="Upload Document">
              📎
            </label>
          </div>

          <textarea
            ref={(el) => {
              // Auto-resize logic
              if (el) {
                el.style.height = 'auto';
                el.style.height = Math.min(el.scrollHeight, 120) + 'px'; // Max height ~120px
              }
            }}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
              }
            }}
            placeholder="Type a message"
            disabled={isLoading}
            className={styles.input}
            rows={1}
          />

          <button
            onClick={sendMessage}
            disabled={isLoading || !input.trim()}
            className={styles.sendButton}
          >
            {isLoading ? '...' : '➤'}
          </button>
        </div>
      </main>
    </div>
  );
}
