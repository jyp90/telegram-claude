#!/bin/bash
# install-new-device.sh - 새 기기에서 telegram-claude MCP 설치
#
# 사전 준비:
#   - Claude Code 설치: https://claude.ai/code
#   - Bun 설치: curl -fsSL https://bun.sh/install | bash
#
# 사용법:
#   curl -fsSL https://raw.githubusercontent.com/jyp90/telegram-claude/main/install-new-device.sh | bash
#   또는 클론 후: ./install-new-device.sh

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'

REPO_URL="https://github.com/jyp90/telegram-claude.git"
INSTALL_DIR="$HOME/Projects/telegram-claude"
STATE_DIR="$HOME/.claude/channels/telegram"
ENV_FILE="$STATE_DIR/.env"
ACCESS_FILE="$STATE_DIR/access.json"

echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${CYAN}  Telegram Claude MCP — 새 기기 설치${NC}"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"; echo ""

# 1. bun 확인
BUN_PATH=$(which bun 2>/dev/null || echo "$HOME/.bun/bin/bun")
if [ ! -f "$BUN_PATH" ]; then
  echo -e "${RED}[오류]${NC} bun이 없습니다."
  echo "  설치: curl -fsSL https://bun.sh/install | bash"
  exit 1
fi
echo -e "${GREEN}[1/5]${NC} bun: $BUN_PATH"

# 2. claude 명령어 확인
if ! command -v claude &>/dev/null; then
  echo -e "${RED}[오류]${NC} claude 명령어가 없습니다."
  echo "  설치: https://claude.ai/code"
  exit 1
fi
echo -e "${GREEN}[2/5]${NC} claude: $(which claude)"

# 3. 프로젝트 클론 또는 업데이트
if [ -d "$INSTALL_DIR/.git" ]; then
  echo -e "${GREEN}[3/5]${NC} 프로젝트 업데이트 중..."
  git -C "$INSTALL_DIR" pull --quiet
else
  echo -e "${GREEN}[3/5]${NC} 프로젝트 클론 중..."
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone --quiet "$REPO_URL" "$INSTALL_DIR"
fi
cd "$INSTALL_DIR"
"$BUN_PATH" install --no-summary
echo -e "  완료: $INSTALL_DIR"

# 4. 봇 토큰 설정
mkdir -p "$STATE_DIR"
if [ -f "$ENV_FILE" ]; then
  echo -e "${GREEN}[4/5]${NC} 봇 토큰 이미 존재: $ENV_FILE"
else
  echo ""
  echo -e "${YELLOW}[4/5]${NC} 봇 토큰 설정"
  echo -n "  TELEGRAM_BOT_TOKEN 입력: "
  read -r TOKEN
  echo "TELEGRAM_BOT_TOKEN=$TOKEN" > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo -e "  저장 완료: $ENV_FILE"

  echo ""
  echo -n "  내 Telegram User ID 입력 (t.me/userinfobot에서 확인): "
  read -r USER_ID
  echo "{\"dmPolicy\":\"allowlist\",\"allowFrom\":[\"$USER_ID\"],\"groups\":{},\"pending\":{}}" > "$ACCESS_FILE"
  echo -e "  저장 완료: $ACCESS_FILE"
fi

# 5. MCP 등록 (claude mcp add)
echo -e "${GREEN}[5/5]${NC} Claude Code MCP 등록..."
if claude mcp list 2>/dev/null | grep -q "telegram-pull"; then
  claude mcp remove telegram-pull --scope user 2>/dev/null || true
fi
claude mcp add telegram-pull --scope user -- "$BUN_PATH" "$INSTALL_DIR/server.ts"
echo -e "  등록 완료"

echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  설치 완료!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "다음 단계:"
echo "  1. claude 실행 (새 세션 시작)"
echo "  2. Telegram에서 봇에게 메시지 전송"
echo "  3. Claude에서: /loop 1m get_messages 툴 호출해서 새 텔레그램 메시지 있으면 답장해줘"
echo ""
echo "채널 ID 확인: ~/.claude/channels/telegram/access.json"
echo "봇 토큰 위치: ~/.claude/channels/telegram/.env"
