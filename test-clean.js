const thinkingText = `**Prioritizing Tool Usage**\n\nI'm now focusing on tool selection, emphasizing specific tools over general ones where possible. The goal is to optimize efficiency by leveraging tools like 'view_file' directly, rather than resorting to broader, less direct methods. I'm aiming for targeted actions.\n\n\n**Refining Tool Application**\n\nI'm now refining my approach to tool usage by explicitly listing related tools before any execution, adhering to my critical instructions. I avoid cat, grep within bash commands, and generalized tools like ls, cat, grep, and sed unless absolutely necessary, and only execute a set of tools T if all other tools are unavailable.\n\n\n`;

function cleanAntigravityThinkingText(thinkingText) {
  const cleaned = String(thinkingText || "")
    .replace(/Read the full task from stdin and answer it\./gi, "")
    .replace(/Bridge transport placeholder\. Answer the Telegram message provided in stdin\./gi, "")
    .replace(/CRITICAL INSTRUCTION\s+\d:[\s\S]*?(?=\n\n|\*\*|$)/gi, "")
    .replace(/<bash_command_reminder>[\s\S]*?<\/bash_command_reminder>/gi, "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  console.log('cleaned length:', cleaned.length);
  
  if (!cleaned) {
    return "";
  }

  const sections = cleaned.split(/(?=\n?\*\*[^*\n]+\*\*\n)/g);
  const kept = sections.filter((section) => {
    const heading = (section.match(/\*\*([^*\n]+)\*\*/) || [])[1] || "";
    return !/tool|command|stdin|placeholder|cli call|data flow|input mechanism/i.test(
      heading
    );
  });

  console.log('sections:', sections);
  console.log('kept:', kept);

  return (kept.length ? kept : sections)
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

console.log('Result length:', cleanAntigravityThinkingText(thinkingText).length);
