import fs from 'fs'

const bugs = []
const ok = (id, c, d='') => { if (!c) { bugs.push({id,d}); console.log(' FAIL', id, d) } else console.log(' OK', id, d) }

// Titlebar
const main = fs.readFileSync('src/main/index.ts','utf8')
ok('titlebar-height-40', main.includes('height: 40') || main.includes('height: c.height'))
ok('titlebar-dark-surface', main.includes('#28282b'))
ok('titlebar-light-white', main.includes("#ffffff") || main.includes("'#ffffff'"))
const css = fs.readFileSync('src/renderer/src/styles/globals.css','utf8')
ok('titlebar-env', css.includes('titlebar-area-height') && css.includes('titlebar-area-width'))
ok('titlebar-inner', css.includes('app-titlebar-inner'))
const shell = fs.readFileSync('src/renderer/src/components/layout/AppShell.tsx','utf8')
ok('shell-titlebar-inner', shell.includes('app-titlebar-inner') && !shell.includes("marginRight: '80px'"))

// Chat panel
const chat = fs.readFileSync('src/renderer/src/components/chat/ChatPanel.tsx','utf8')
ok('chat-history', chat.includes('listChats') && chat.includes('showHistory'))
ok('chat-new', chat.includes('handleNewChat'))
ok('chat-close', chat.includes('toggleAIChat'))
ok('chat-confirm-clear', chat.includes('confirm'))
ok('chat-smart-scroll', chat.includes('stickToBottom'))
ok('chat-autogrow', chat.includes('scrollHeight'))
ok('chat-model-fallback', chat.includes('modelValue') || chat.includes('modelOptions'))
ok('chat-context-chip', chat.includes('chat-context-chip') || chat.includes('activeTab.title'))
ok('chat-hints', chat.includes('chat-hint') || chat.includes('chat-empty-hints'))

ok('css-chat-clamp', css.includes('clamp(300px') || css.includes('30vw'))
ok('css-chat-toolbar', css.includes('chat-toolbar'))
ok('css-chat-history', css.includes('chat-history'))
ok('css-chat-toggle', css.includes('chat-toggle'))
ok('css-slide-in', css.includes('slideInRight'))

// Icons used exist?
const icons = fs.readFileSync('src/renderer/src/components/ui/Icons.tsx','utf8')
for (const name of ['bot','plus','file','save','trash','close','warning']) {
  ok('icon-'+name, icons.includes("'"+name+"'") || icons.includes('"'+name+'"') || icons.includes(name+':'))
}

console.log('\n'+(bugs.length? 'BUGS '+JSON.stringify(bugs,null,2):'RECHECK_OK'))
process.exit(bugs.length?1:0)
