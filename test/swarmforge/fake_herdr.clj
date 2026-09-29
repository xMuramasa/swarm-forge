(ns swarmforge.fake-herdr
  "A fake `herdr` binary for tests, so nothing talks to the real herdr server.
   State is per test directory: <dir>/.fake-herdr."
  (:require [babashka.fs :as fs]
            [clojure.string :as str]))

(def bin-dir
  (delay
    (let [dir (fs/create-temp-dir {:prefix "fake-herdr-bin."})
          herdr (fs/path dir "herdr")]
      (fs/copy (fs/path (fs/cwd) "test" "swarmforge" "fake-herdr.sh") herdr)
      (fs/set-posix-file-permissions herdr "rwxr-xr-x")
      (fs/delete-on-exit dir)
      (str dir))))

(defn state-dir [dir]
  (fs/path dir ".fake-herdr"))

(defn env
  "Environment that puts the fake herdr first on PATH, with state under `dir`."
  [dir]
  {"PATH" (str @bin-dir ":" (System/getenv "PATH"))
   "FAKE_HERDR_DIR" (str (state-dir dir))})

(defn add-agents!
  "Make each named agent alive. `text` is what `agent read` prints for it."
  [dir names & [text]]
  (fs/create-dirs (fs/path (state-dir dir) "agents"))
  (doseq [name names]
    (spit (str (fs/path (state-dir dir) "agents" name)) (or text ""))))

(defn set-status!
  "Make `agent get` report `status` (idle, working, blocked, ...) for an agent."
  [dir name status]
  (fs/create-dirs (fs/path (state-dir dir) "status"))
  (spit (str (fs/path (state-dir dir) "status" name)) status))

(defn- read-log [dir file]
  (let [path (fs/path (state-dir dir) file)]
    (if (fs/exists? path)
      (str/split-lines (slurp (str path)))
      [])))

(defn calls
  "Every herdr invocation as its argument string, in order."
  [dir]
  (read-log dir "calls.log"))

(defn prompts
  "[[agent-name text] ...] in the order `agent prompt` was called."
  [dir]
  (mapv #(str/split % #"\t" 2) (read-log dir "prompts.log")))

(defn closed [dir]
  (read-log dir "closed.log"))
