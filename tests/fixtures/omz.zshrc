# Path to your Oh My Zsh installation.
export ZSH="$HOME/.oh-my-zsh"

# Set name of the theme to load
ZSH_THEME="robbyrussell"

# Plugins
plugins=(git docker docker-compose)

# Don't actually source omz in the test fixture (the test HOME won't have it).
# In a real .zshrc this would be:
#   source $ZSH/oh-my-zsh.sh
[ -f "$ZSH/oh-my-zsh.sh" ] && source "$ZSH/oh-my-zsh.sh"

# User configuration
export LANG=en_US.UTF-8
export EDITOR='vim'

# History
HISTFILE=~/.zsh_history
HISTSIZE=10000
SAVEHIST=10000

# User-installed binaries
export PATH="$HOME/.local/bin:$PATH"

# pnpm
export PNPM_HOME="$HOME/.local/share/pnpm"
case ":$PATH:" in
  *":$PNPM_HOME:"*) ;;
  *) export PATH="$PNPM_HOME:$PATH" ;;
esac

# Aliases
alias ll='ls -lh'
alias gs='git status'
