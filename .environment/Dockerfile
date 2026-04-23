FROM codercom/code-server:latest
USER root
RUN apt-get update 
RUN apt-get install -y build-essential libsqlite3-dev sqlite3 gcc
RUN apt-get install -y curl
RUN apt-get install unzip
ENV HOME="/home/coder"
ENV DENO_INSTALL="$HOME/.deno"
RUN echo "export PATH=\"$DENO_INSTALL/bin:\$PATH\"" >> $HOME/.bashrc
RUN curl -fsSL https://deno.land/install.sh | sh
RUN apt-get install -y gpg
RUN mkdir -p /etc/apt/keyrings && \
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg && \
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list
RUN apt-get update
RUN apt-get install -y nodejs
RUN npm install -g @google/gemini-cli
RUN rm -rf /home/coder/.cache
USER coder
