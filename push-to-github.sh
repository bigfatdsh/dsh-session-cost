#!/usr/bin/env bash
#
# 一条命令把这个插件推到 GitHub：确定账号 → 确保仓库 → 推送 → 打印链接。
#
# 两种认证方式，任选其一：
#
#   A. SSH（推荐；公钥是公开信息，不必进聊天）
#      1) 把 ~/.ssh/id_ed25519_github_dsh.pub 的内容加到
#         https://github.com/settings/keys
#      2) 在 https://github.com/new 建一个**空**仓库（不要勾 README / .gitignore）
#      3) ./push-to-github.sh
#
#   B. Token（脚本可以顺带把仓库建出来）
#      GITHUB_TOKEN=<细粒度 token，需 Contents: Read and write + Administration: Read and write> \
#        ./push-to-github.sh
#
# 用法：./push-to-github.sh [仓库名]        仓库名默认取 package.json 的 name
#
set -euo pipefail

cd "$(dirname "$0")"

REPO_NAME="${1:-$(sed -n 's/.*"name": *"\([^"]*\)".*/\1/p' package.json | head -1)}"
ALIAS="${ALIAS:-github-dsh}"   # ~/.ssh/config 里指向 github.com 的主机别名
API="https://api.github.com"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[31m!! %s\033[0m\n' "$*" >&2; exit 1; }

# 从 GitHub 的 JSON 里抠出 "login" 字段，不依赖 jq。
api_login() {
  grep -o '"login": *"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/'
}

# ---------------------------------------------------------------- B. token
if [ -n "${GITHUB_TOKEN:-}" ]; then
  say "1/4 用 token 确认账号"
  OWNER=$(curl -fsS -H "Authorization: Bearer $GITHUB_TOKEN" \
            -H 'Accept: application/vnd.github+json' "$API/user" | api_login)
  [ -n "$OWNER" ] || die "token 无效，或缺少读取账号的权限"
  echo "    $OWNER"

  say "2/4 确保仓库存在"
  code=$(curl -s -o /dev/null -w '%{http_code}' \
           -H "Authorization: Bearer $GITHUB_TOKEN" \
           -H 'Accept: application/vnd.github+json' "$API/repos/$OWNER/$REPO_NAME")
  if [ "$code" = "200" ]; then
    echo "    已存在，跳过创建"
  else
    curl -fsS -X POST -H "Authorization: Bearer $GITHUB_TOKEN" \
      -H 'Accept: application/vnd.github+json' "$API/user/repos" \
      --data "$(printf '{"name":"%s","description":"%s","private":false}' \
                "$REPO_NAME" "DSH 插件：在 token 用量旁显示本轮 / 本会话花费")" >/dev/null
    echo "    已创建"
  fi

  say "3/4 配置 remote"
  git remote remove origin 2>/dev/null || true
  git remote add origin "https://github.com/$OWNER/$REPO_NAME.git"
  git remote -v

  say "4/4 推送 main"
  # token 只作为这一次 push 的请求头，不写进 .git/config。
  git -c http.extraheader="Authorization: Bearer $GITHUB_TOKEN" push -u origin main

# ---------------------------------------------------------------- A. SSH
else
  say "1/4 检查 SSH 认证"
  if ! ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -T "git@$ALIAS" 2>&1 \
       | grep -q "successfully authenticated"; then
    die "SSH 认证未通过。请把下面这行公钥加到 https://github.com/settings/keys 后重试：
    $(cat ~/.ssh/id_ed25519_github_dsh.pub 2>/dev/null || echo '(找不到公钥文件)')"
  fi
  OWNER=$(ssh -T "git@$ALIAS" 2>&1 | sed -n 's/^Hi \([^!]*\)!.*/\1/p')
  echo "    认证通过：$OWNER"

  say "2/4 确认仓库已存在"
  # git 自己不能建仓库，所以这一步只能检查。
  if ! git ls-remote "git@$ALIAS:$OWNER/$REPO_NAME.git" >/dev/null 2>&1; then
    die "仓库 $OWNER/$REPO_NAME 还不存在（或无权访问）。
    请先在 https://github.com/new 建一个**空**仓库（不要勾 README），
    或者改用 token 方式：GITHUB_TOKEN=... ./push-to-github.sh"
  fi
  echo "    已存在"

  say "3/4 配置 remote"
  git remote remove origin 2>/dev/null || true
  git remote add origin "git@$ALIAS:$OWNER/$REPO_NAME.git"
  git remote -v

  say "4/4 推送 main"
  git push -u origin main
fi

printf '\n\033[32m完成：https://github.com/%s/%s\033[0m\n' "$OWNER" "$REPO_NAME"
