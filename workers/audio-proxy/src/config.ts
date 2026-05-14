export const DEFAULT_ALLOWED_HOST_PATTERNS = [
  '^[a-z0-9-]+\\.bilivideo\\.com$',
  '^[a-z0-9-]+\\.bilivideo\\.cn$',
  '^[a-z0-9-]+\\.mcdn\\.bilivideo\\.cn$',
  '^[a-z0-9-]+\\.akamaized\\.net$',
  '^upos-[a-z0-9-]+\\.(bilivideo|akamaized)\\.(com|cn|net)$',
] as const

export const BILIBILI_HEADERS = {
  Referer: 'https://www.bilibili.com',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Origin: 'https://www.bilibili.com',
} as const
