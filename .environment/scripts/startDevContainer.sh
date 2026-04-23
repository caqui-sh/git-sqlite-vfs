#/bin/sh

docker run -it --rm -p 127.0.0.1:8080:8080 \
  -v "$HOME/.coder-local:/home/coder/.local" \
  -v "$HOME/.coder-config:/home/coder/.config" \
  -v "$PWD:/home/coder/project" \
  -u "$(id -u):$(id -g)" \
  -e "DOCKER_USER=$USER" \
  git-sqlite-vfs-container
