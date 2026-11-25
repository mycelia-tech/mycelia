import type { Platform } from "../core/types.ts";
import { defaultPlatform } from "./default.tsx";
import { Send, PhoneCall, Video, File, Download, Reply, Forward } from "lucide-react";
import { Link } from "react-router-dom";
import { useFormattedTime } from "@/lib/formatTime";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;

  const parts = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (s > 0 || parts.length === 0) parts.push(`${s}s`);

  return parts.join(" ");
}

function renderTelegramText(text: any): React.ReactNode {
  if (typeof text === 'string') {
    return <span className="whitespace-pre-wrap break-words">{text}</span>;
  }
  
  if (Array.isArray(text)) {
    return (
      <>
        {text.map((part, i) => {
          if (typeof part === 'string') return <span key={i} className="whitespace-pre-wrap">{part}</span>;
          if (typeof part === 'object' && part !== null && part.text) {
            switch (part.type) {
              case 'bold': return <strong key={i} className="font-semibold">{part.text}</strong>;
              case 'italic': return <em key={i}>{part.text}</em>;
              case 'code': return <code key={i} className="bg-black/10 dark:bg-white/10 px-1.5 py-0.5 rounded font-mono text-[0.9em]">{part.text}</code>;
              case 'pre': return <pre key={i} className="bg-black/10 dark:bg-white/10 p-2 rounded font-mono text-[0.9em] my-1 overflow-x-auto">{part.text}</pre>;
              case 'link': return <a key={i} href={part.href || '#'} className="text-[#3390ec] dark:text-[#71aaeb] hover:underline" target="_blank" rel="noreferrer">{part.text}</a>;
              case 'mention': return <span key={i} className="text-[#3390ec] dark:text-[#71aaeb] cursor-pointer hover:underline">{part.text}</span>;
              case 'hashtag': return <span key={i} className="text-[#3390ec] dark:text-[#71aaeb] cursor-pointer hover:underline">{part.text}</span>;
              case 'strikethrough': return <s key={i}>{part.text}</s>;
              case 'underline': return <u key={i}>{part.text}</u>;
              case 'spoiler': return <span key={i} className="bg-muted-foreground text-muted-foreground hover:bg-transparent hover:text-foreground transition-colors cursor-pointer rounded px-0.5">{part.text}</span>;
              default: return <span key={i}>{part.text}</span>;
            }
          }
          return null;
        })}
      </>
    );
  }
  
  if (typeof text === 'object' && text !== null && text.text) {
    return <span className="whitespace-pre-wrap">{text.text}</span>;
  }
  
  return null;
}

interface TelegramBubbleProps {
  message: import("@myceliasdk/messengers.ts").Message;
  children?: React.ReactNode;
}

function TelegramBubble({ message, children }: TelegramBubbleProps) {
  const formattedDate = useFormattedTime(new Date(message.timestamp));
  const raw = message.raw;
  
  const senderName = raw?.from || raw?.sender_name || "Unknown";
  const senderColor = generateSenderColor(senderName);
  
  const hasReply = raw?.reply_to_message_id || raw?.reply_to;
  const replyPreview = hasReply ? (raw?.reply_to?.text || raw?.reply_to_text) : null;
  const replyAuthor = hasReply ? (raw?.reply_to?.from || raw?.reply_to_author) : null;
  
  const isForwarded = !!message.forwardedFrom;
  const forwardedName = message.forwardedFrom?.name;


  return (
    <div className="flex w-full py-1.5 group">
      <div className="flex flex-col max-w-[85%] sm:max-w-[70%] min-w-0">
        {/* Sender Name */}
        <div className="flex items-center gap-1.5 mb-0.5 ml-3">
          <span className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: senderColor }} aria-hidden="true" />
          {message.senderId ? (
            <Link className="break-words text-sm font-semibold text-primary hover:underline" to={`/objects/${message.senderId.toString()}`}>
              {senderName}
            </Link>
          ) : <span className="break-words text-sm font-semibold">{senderName}</span>}
        </div>
        
        {/* Message Bubble */}
        <div className="relative">
          {/* Bubble Tail */}
          <div 
            className="absolute left-0 top-0 w-3 h-3 overflow-hidden"
            style={{ transform: 'translateX(-6px)' }}
          >
            <div className="w-4 h-4 bg-white dark:bg-[#212121] rounded-br-[12px] transform rotate-45 translate-x-2" />
          </div>
          
          {/* Bubble Content */}
          <div className={cn(
            "relative bg-white dark:bg-[#212121] rounded-2xl rounded-tl-sm px-3 py-2",
            "shadow-[0_1px_2px_rgba(0,0,0,0.08)] dark:shadow-[0_1px_2px_rgba(0,0,0,0.3)]",
            "border border-black/[0.04] dark:border-white/[0.06]"
          )}>
            {/* Forwarded Indicator */}
            {isForwarded && (
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1.5 pb-1.5 border-b border-black/5 dark:border-white/5">
                <Forward className="w-3 h-3" />
                <span>Forwarded from</span>
                <span className="font-medium text-[#3390ec] dark:text-[#71aaeb]">{forwardedName}</span>
              </div>
            )}
            
            {/* Reply Preview */}
            {hasReply && (
              <div className="flex items-stretch gap-2 mb-2 cursor-pointer hover:opacity-80 transition-opacity">
                <div className="w-0.5 bg-[#3390ec] dark:bg-[#71aaeb] rounded-full shrink-0" />
                <div className="flex flex-col min-w-0 py-0.5">
                  {replyAuthor && (
                    <span className="text-xs font-medium text-[#3390ec] dark:text-[#71aaeb] truncate">
                      {replyAuthor}
                    </span>
                  )}
                  {replyPreview && (
                    <span className="text-xs text-muted-foreground truncate max-w-[200px]">
                      {typeof replyPreview === 'string' ? replyPreview : 'Message'}
                    </span>
                  )}
                  {!replyPreview && !replyAuthor && (
                    <span className="text-xs text-muted-foreground flex items-center gap-1">
                      <Reply className="w-3 h-3" />
                      Reply
                    </span>
                  )}
                </div>
              </div>
            )}
            
            {/* Message Content */}
            <div className="break-words text-base leading-relaxed text-foreground">
              {children}
            </div>
            
            {/* Timestamp */}
            <div className="flex justify-end mt-1 -mb-0.5 -mr-1">
              <span className="text-xs text-muted-foreground select-none">
                {formattedDate}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function generateSenderColor(name: string): string {
  const colors = [
    '#e17076', // red
    '#7bc862', // green
    '#e5ae5b', // orange
    '#6ec9cb', // cyan
    '#65aadd', // blue
    '#a695e7', // purple
    '#ee7aae', // pink
    '#6ec9a8', // teal
  ];
  
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  
  return colors[Math.abs(hash) % colors.length];
}

const TelegramMessageComponent: Platform["MessageComponent"] = ({ message }) => {
  const raw = message.raw;

  // Handle Phone Call Service Messages
  if (raw?.type === "service" && raw?.action === "phone_call") {
     const actor = raw.actor || "Unknown User";
     const duration = raw.duration_seconds ? formatDuration(raw.duration_seconds) : null;
     const discardReason = raw.discard_reason;

     return (
         <div className="flex items-center justify-center w-full my-4">
            <div className="flex flex-col items-center gap-1">
                <div className="flex items-center gap-2 text-sm text-muted-foreground bg-muted/50 px-4 py-2 rounded-full shadow-sm border">
                    <PhoneCall className="w-4 h-4" />
                    <span className="font-medium">{actor}</span>
                    <span>called</span>
                    {duration && <span className="font-mono text-xs opacity-80">({duration})</span>}
                </div>
                {discardReason && (
                    <span className="text-xs text-muted-foreground uppercase tracking-wider">
                        {discardReason.replace(/_/g, " ")}
                    </span>
                )}
            </div>
         </div>
     );
  }

  // Handle Video Messages (Circular Video / Video Note)
  if (raw?.media_type === "video_message" || (raw?.mime_type === "video/mp4" && raw?.width === raw?.height)) {
    const mediaItem = message.media?.find(m => m.type === "video");
    const videoUrl = mediaItem?.url || mediaItem?.path;
    const duration = raw.duration_seconds ? formatDuration(raw.duration_seconds) : null;

    return (
        <TelegramBubble message={message}>
           <div className="flex flex-col items-center justify-center gap-2 bg-muted/20 rounded-full aspect-square w-48 h-48 border-4 border-muted overflow-hidden relative group -mx-1">
                {videoUrl ? (
                    <video src={videoUrl} controls className="w-full h-full object-cover" />
                ) : (
                    <div className="flex flex-col items-center text-muted-foreground">
                        <Video className="w-8 h-8 opacity-50 mb-1" />
                        <span className="text-xs font-semibold">Video Message</span>
                        {duration && <span className="text-xs">{duration}</span>}
                        <span className="text-xs mt-1 italic">File not available</span>
                    </div>
                )}
           </div>
        </TelegramBubble>
    );
  }

  // Handle Generic File Messages (Documents/APKs/etc)
  if (raw?.file_name || raw?.mime_type) {
    const fileName = raw.file_name || "Unknown File";
    const mimeType = raw.mime_type || "application/octet-stream";
    const mediaItem = message.media?.find(m => m.type === "file");
    const fileUrl = mediaItem?.url || mediaItem?.path;
    
    const isGenericFile = !message.text && !message.media?.some(m => m.type === "image" || m.type === "video" || m.type === "audio");

    if (isGenericFile || raw.file_name) {
        return (
            <TelegramBubble message={message}>
                <div className="flex items-center gap-3 -mx-1 -my-0.5">
                    <div className="bg-[#3390ec]/10 dark:bg-[#71aaeb]/10 p-2.5 rounded-xl">
                        <File className="w-5 h-5 text-[#3390ec] dark:text-[#71aaeb]" />
                    </div>
                    <div className="flex flex-col flex-1 min-w-0">
                        <span className="text-sm font-medium truncate" title={fileName}>
                            {fileName}
                        </span>
                        <span className="text-xs text-muted-foreground truncate">
                            {mimeType}
                        </span>
                    </div>
                    {fileUrl && (
                        <a href={fileUrl} download={fileName} target="_blank" rel="noreferrer">
                            <Button size="icon" variant="ghost" className="h-8 w-8 hover:bg-[#3390ec]/10 dark:hover:bg-[#71aaeb]/10">
                                <Download className="w-4 h-4 text-[#3390ec] dark:text-[#71aaeb]" />
                            </Button>
                        </a>
                    )}
                </div>
            </TelegramBubble>
        );
    }
  }

  // Handle Text Messages (primary use case)
  const hasText = !!message.text?.length;

  if (hasText) {
    return (
      <TelegramBubble message={message}>
        {renderTelegramText(message.text)}
      </TelegramBubble>
    );
  }

  // Handle messages with only media (images, etc)
  if (message.media && message.media.length > 0) {
    return (
      <TelegramBubble message={message}>
        <div className="flex flex-wrap gap-1 -mx-1">
          {message.media.map((media, idx) => {
            if (media.type === "image" && media.url) {
              return (
                <img 
                  key={idx} 
                  src={media.url} 
                  alt="media" 
                  className="max-w-full sm:max-w-[min(100%,280px)] rounded-lg h-auto cursor-pointer hover:opacity-90 transition-opacity"
                />
              );
            }
            if (media.type === "sticker") {
              return (
                <img 
                  key={idx} 
                  src={media.url} 
                  alt="sticker" 
                  className="w-32 h-32 object-contain" 
                />
              );
            }
            return (
              <div key={idx} className="flex items-center gap-2 p-2 bg-muted/30 rounded-lg">
                <span className="text-xs uppercase font-bold text-muted-foreground">{media.type}</span>
                <span className="text-xs truncate max-w-[150px]">{media.fileName || "File"}</span>
              </div>
            );
          })}
        </div>
      </TelegramBubble>
    );
  }

  // Fallback to default renderer for unknown message types
  return <defaultPlatform.MessageComponent message={message} />;
};

export const telegramPlatform: Platform = {
  ...defaultPlatform,
  id: "telegram",
  name: "Telegram",
  icon: Send,
  MessageComponent: TelegramMessageComponent,
};
