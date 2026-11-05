import json

with open('session_user_messages.json', 'r', encoding='utf-8') as f:
    msgs = json.load(f)

count = 0
for i, m in enumerate(msgs):
    msg = m['msg']
    content = msg.get('content')
    text = ''
    if isinstance(content, str):
        text = content
    elif isinstance(content, list):
        for part in content:
            if isinstance(part, dict) and part.get('type') == 'text':
                text += part.get('text', '')
            elif isinstance(part, str):
                text += part
    
    t = text.strip()
    if t.startswith('<system-reminder>') or t.startswith('Current runtime context') or t.startswith('Time sampled') or t.startswith('<path>') or t.startswith('<referenced-sessions>'):
        continue
    if not t:
        continue
    count += 1
    print(f"=== Prompt #{count} (seq={m.get('seq')}) ===")
    print(t)
    print()
