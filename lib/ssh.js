"use strict";

const Client            = require('ssh2').Client,
      async             = require('async'),
      { exec, spawn }   = require('child_process'),
      path              = require('path'),
      readline          = require('readline'),
      pdsh              = require('./pdsh'),
      EOL               = require('os').EOL,
      fs                = require('fs');

module.exports.init = function (opts, machines, callback) {
  if (!opts.PS1) opts.PS1 = "knight> ";

  if (!opts.nodeSSH) {
    pdsh.checkForPDSH((hasPDSH) => {
      if (hasPDSH) return pdsh.runPDSH(opts, machines, callback);
      return startShell(opts, machines, callback);
    });
  } else {
    return startShell(opts, machines, callback);
  }
}

function startShell(opts, machines,callback) {
  return new Promise((resolve, reject) => {
    let promise = { resolve, reject };
    // Allows thus utility to be used as either a promise or a callback
    let callbackCalled = false;

    connectClients(opts,machines, (err) => {
      if (err) return callback(err, machines);

      if (opts.file) {
        if (opts.verbose > 0) console.log("Loading file", opts.file);
        uploadSiegeFileShell(opts, machines, (err) => {
          //if (err) return callback(err, machines);
          if (err) console.warn(`Unable to upload Siege File due to ${err.message || JSON.stringify(err)}`);
          nodeShell(opts, machines, promise, callbackCalled, callback);
        })
      } else {
        nodeShell(opts, machines, promise, callbackCalled, callback);
      }
    });

  });
}

module.exports.startShell = startShell;

function connectClients(opts, machines, callback) {
  let keyFile;
  try {
    keyFile = fs.readFileSync(opts.identity);
  } catch(e) {
    console.error(e);
  }
  if (!keyFile) callback(new Error("Unable to get SSH Key"));

  async.each(Array.from(machines.keys()), async.retryable({ times: 6, interval: 10000 },(key, cb) => {
    let callbackCalled = false;
    try {
      if (opts.verbose > 0) console.log("SSH connection to",key);
      let machine = machines.get(key);
      machine.ssh = new Client();
      machine.ssh.on('ready', () => {
        machine.sshAlive = true;
        callbackCalled = true;
        return cb()
      })
      machine.ssh.connect({
        host: machine.ip,
        port: 22,
        username: opts.username,
        privateKey: keyFile,
        readyTimeout: 50000,
        keepaliveInterval: 2000
      });
      machine.ssh.on("error", (error) => {
        //if (opts.verbose > 0) 
        console.error(error);
        if (!callbackCalled) {
          callbackCalled = true;
          return cb(error);
        }
      });
      machine.ssh.on("end", () => {
        machine.sshAlive = false;
        console.log(key,"ended SSH connection");
      })
    } catch (e) {
      console.error(e);
      if (!callbackCalled) {
        callbackCalled = true;
        return cb(e);
      }
    }
  }), callback);
}

function uploadSiegeFileShell(opts, machines, callback) {
  let siegeFilePath = `/home/${opts.username}/${path.basename(opts.file)}`;
  fs.readFile(opts.file, (err, siegeFile) => {
    if (err) return callback(err);
    async.each(Array.from(machines.keys()), (key, cb) => {
      let machine = machines.get(key);
      if (opts.verbose > 0) console.log("Uploading siegefile",siegeFilePath,"to",key);
      let ssh = machine.ssh;
      ssh.sftp((err, sftp) => {
        if (err) return cb(err);
        sftp.open(siegeFilePath, 'w', "0755", (error, handle) => {
          if (error) return cb(error);
          sftp.write(handle, siegeFile, 0, siegeFile.length, 0, (ferr) => {
            if (ferr) console.warn(ferr);
            cb(ferr);
          })
        })
      })
    }, callback);
  });
}


function nodeShell(opts, machines, promise, callbackCalled, callback) {
  let logFile;
  let lastSIGINT = 0;
  if (opts.outputFile) {
    logFile = fs.createWriteStream(opts.outputFile, {autoClose: false});
  }
  let readies = 0;
  let machinesReady = machines.size;
  machines.forEach(machine => {
      machine.ssh.on("end", () => {
        machinesReady = machinesReady - 1;
    });
  });


  console.log("Ready to siege...\n(type 'exit' or use Ctrl-c to quit knight)");
  let rl = readline.createInterface({
    output: process.stdout, 
    input: process.stdin, 
    prompt: opts.PS1
  });

  rl.prompt();


  //process.stdout.write(opts.PS1);

  rl.on("line", (data) => {
    let input = data.toString('utf-8');
    // If the command is "exit" (or we SIGINT), we should start the next phase.
    if (machinesReady === 0) {
      console.error("My Liege, we have run out of siege machines, all is lost!");
      if (typeof callback === "function" && !callbackCalled) {
        callbackCalled = true;
        return callback(null, machines);
      }
    }
    readies = 0;
    if (input.trim().length === 0) {
      rl.prompt();
      return;
    }

    if (/^exit/.test(input)) {
      if (logFile) {
        logFile.end(); 
        logFile = null;
      }
      machines.forEach(machine => machine.ssh.end());
      if (typeof callback === "function" && !callbackCalled) {
        callbackCalled = true;
        return callback(null, machines);
      }
      return promise.resolve();
    }
    if (logFile) logFile.write(opts.PS1 + input + "\n");

    machines.forEach((machine,name) => {
      if (machine.sshAlive){
        machine.ssh.exec(input,{ pty: true }, (err, stream) => {
          machine.lastExecStream = stream;
          if (opts.verbose > 1) console.log(input.toString("utf-8"), "sent to",name,"err is",err);
          if (err) {
            process.stderr.write(err);
          } else {
            stream.on("data", (input) => {
              let data = input.toString('utf-8');
              if (opts.verbose > 2) console.log(input);
              if (data.length > 0 && data !== "\n" && data !== "\r\n" && data !== "\r") {
                let writeChunk = name + ": " + data + (data.substring(data.length - EOL.length) === EOL ? "" : EOL);
                process.stdout.write(writeChunk);
                if (logFile) logFile.write(writeChunk)
              }
            })
            stream.stderr.on("data", (input) => {
              let data = input.toString('utf-8');
              if (data.length > 0 && data !== "\n" && data !== "\r\n" && data !== "\r") {
                let writeChunk = "E:" + name + ": " + data + (data.substring(data.length - EOL.length) === EOL ? "" : EOL)
                process.stdout.write(writeChunk);
                if (logFile) logFile.write(writeChunk);
              }
            })
            stream.on("end", () => {
              stream.ended = true;
              readies += 1;
              if (readies >= machinesReady) rl.prompt(); //process.stdout.write(opts.PS1);
            });
          }
        });
      } //if (machine.sshAlive)
    });
  });

  rl.on('SIGINT', () => {
    if ((readies >= machines.size) && ((Date.now() - lastSIGINT) < 500)) {
      rl.question("Are you sure you want to quit? [Y/N] ", answer => {
        if ((/^y|yes/gi).test(answer)) {
          if (logFile) {
            logFile.end(); 
            logFile = null;
          }
          machines.forEach(machine => machine.ssh.end());
          rl.close();
          if (typeof callback === "function" && !callbackCalled) {
            callbackCalled = true;
            return callback(null, machines);
          }
          return promise.resolve();        
        }

      });
    } else {
      machines.forEach(machine => {
        if (!machine.lastExecStream.ended) {
          let shouldWait = machine.lastExecStream.signal("INT");
          shouldWait = shouldWait | machine.lastExecStream.write('\x03');
          shouldWait = shouldWait | machine.lastExecStream.stdin.write('\x03');
          if (!shouldWait) {
            machine.lastExecStream.on("continue", () => {
              machine.lastExecStream.signal("INT");
              machine.lastExecStream.write("\x03");
              machine.lastExecStream.stdin.write("\x03");
              machine.lastExecStream.end();
              machine.lastExecStream.ended = true;
            });
          } else {
            machine.lastExecStream.end();
            machine.lastExecStream.ended = true;
          }
        }
      })
    }

    lastSIGINT = Date.now();
  });

  rl.on('end', () => {
    if (typeof callback === "function" && !callbackCalled) {
      callbackCalled = true;
      return callback(null, machines);
    }    
  });

}