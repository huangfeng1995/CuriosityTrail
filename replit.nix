language = "nodejs"

entrypoint = "web/server/index.js"

[nix]
channel = "stable-24.05"

[env]
PORT = "3000"

[deployment]
run = ["cd", "web/server", "npm", "start"]
build = ["cd", "web/client", "npm", "install", "&&", "npm", "run", "build", "&&", "cd", "../server", "npm", "install"]
