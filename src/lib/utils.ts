import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function isValidImageUrl(url: string): boolean {
  if (!url || typeof url !== 'string') return false;
  
  // Check if it's a valid URL
  try {
    new URL(url);
  } catch {
    return false;
  }
  
  // Check if it ends with common image extensions
  const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg'];
  const lowercaseUrl = url.toLowerCase();
  
  return imageExtensions.some(ext => lowercaseUrl.includes(ext));
}
