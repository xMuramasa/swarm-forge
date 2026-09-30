#!/usr/bin/env bb

;; Thin wrapper over the herdr CLI. Every script that used to shell out to
;; tmux goes through here. One herdr workspace per project holding every role as a
;; pane in one tab, and one herdr agent per role named sf-<project>-<role>.

(ns herdr
  (:require [babashka.fs :as fs]
            [cheshire.core :as json]
            [clojure.java.shell :as shell]
            [clojure.string :as str]))

(def max-name-length 32)
(def read-lines 2000)

(def ^:dynamic *stub* nil)

(defn stub
  "File that records `agent prompt` argv instead of running it (tests)."
  []
  (or *stub* (System/getenv "SWARMFORGE_HERDR_STUB")))

(defn cli
  "Run herdr. Returns {:ok? :out :result :error}; :result/:error come from the JSON body."
  [& args]
  (let [{:keys [exit out err]} (apply shell/sh "herdr" (map str args))
        body (try (json/parse-string (if (str/blank? out) err out) true)
                  (catch Exception _ nil))]
    {:ok? (zero? exit) :out out :result (:result body) :error (:error body)}))

(defn cli! [& args]
  (let [r (apply cli args)]
    (if (:ok? r)
      (:result r)
      (throw (ex-info (str "herdr " (str/join " " (take 2 args)) " failed: "
                           (or (get-in r [:error :message]) (str/trim (str (:out r)))))
                      r)))))

(defn clean [s]
  (-> (str/lower-case (str s))
      (str/replace #"[^a-z0-9_-]+" "-")
      (str/replace #"^-+|-+$" "")))

(defn project-slug [root]
  (clean (fs/file-name (fs/absolutize root))))

(defn agent-name
  "sf-<project>-<role>, lowercased, at most 32 characters (herdr's limit).
   ponytail: two projects with the same directory name collide; add a hash if that bites."
  [root role]
  (let [role (clean role)
        room (- max-name-length (count "sf--") (count role))]
    (when-not (pos? room)
      (throw (ex-info (str "role name too long for a herdr agent name: " role) {})))
    (str "sf-" (subs (project-slug root) 0 (min room (count (project-slug root)))) "-" role)))

;; -- workspace -------------------------------------------------------------

(defn workspace-file [root]
  (fs/path root ".swarmforge" "herdr-workspace"))

(defn workspace-id [root]
  (let [file (workspace-file root)]
    (when (fs/regular-file? file)
      (not-empty (str/trim (slurp (str file)))))))

(defn env-args [env]
  (mapcat (fn [[k v]] ["--env" (str k "=" v)]) env))

(defn grid-plan
  "How to split panes into a grid for `n` roles: two rows, ceil(n/2) columns, the top row
   filled first. One [from-index direction ratio] per pane after the first; `from-index` is
   the pane to split and `ratio` the share the split pane keeps, so columns come out equal."
  [n]
  (let [cols (if (<= n 2) n (long (Math/ceil (/ n 2.0))))]
    (vec (for [i (range 1 n)]
           (if (< i cols)
             [(dec i) "right" (/ 1.0 (- (inc cols) i))]
             [(- i cols) "down" 0.5])))))

(defn label-pane! [pane label]
  (cli "pane" "rename" pane label))

(defn open-workspace!
  "Create the project workspace with its shell started with `env`. Env goes in at spawn:
   typing exports into a fresh pane races the shell's startup. Returns the first pane id."
  [root cwd env]
  (let [result (apply cli! "workspace" "create" "--cwd" cwd "--label" (project-slug root) "--no-focus"
                      (env-args env))]
    (fs/create-dirs (fs/parent (workspace-file root)))
    (spit (str (workspace-file root)) (str (get-in result [:workspace :workspace_id]) "\n"))
    (cli "tab" "rename" (get-in result [:tab :tab_id]) "swarm")
    (get-in result [:root_pane :pane_id])))

(defn split-pane!
  "Split `from` (`direction` right or down; `ratio` is the share `from` keeps) into a new pane
   started with `env`. Returns the new pane id."
  [from direction ratio cwd env]
  (get-in (apply cli! "pane" "split" from "--direction" direction "--ratio" ratio
                 "--cwd" cwd "--no-focus" (env-args env))
          [:pane :pane_id]))

(defn sq [value]
  (str "'" (str/replace (str value) #"'" "'\"'\"'") "'"))

(defn prepend-path!
  "Put `dirs` first on the pane shell's PATH. Shell startup files reorder PATH, so this runs
   in the live shell; a command typed before the shell is up is dropped, hence the retries.
   The marker is computed by the shell, so the typed command line itself never matches it."
  [pane dirs]
  (let [command (str "export PATH=" (str/join ":" (map sq dirs)) ":$PATH; echo SF_PATH_$((1+1))")]
    (when-not (some (fn [_]
                      (cli "pane" "run" pane command)
                      (:ok? (cli "pane" "wait-output" pane "--match" "SF_PATH_2" "--timeout" 2500)))
                    (range 6))
      (throw (ex-info (str "the shell in pane " pane " never became ready") {:pane pane})))))

(defn one-line
  "herdr rejects control characters (newline, tab) in agent arguments, so multi-line
   text such as a role prompt is joined with single spaces."
  [arg]
  (str/replace (str arg) #"\s*[\r\n\t]+\s*" " "))

(defn start-agent!
  "Start `kind` in `pane` and wait until it is ready for prompts.
   Returns the cli result; :error :code is agent_not_ready when it is parked on a dialog."
  [name kind pane args]
  (apply cli "agent" "start" name "--kind" kind "--pane" pane "--timeout" 60000 "--"
         (map one-line args)))

(defn close-workspace! [root]
  (when-let [ws (workspace-id root)]
    (cli "workspace" "close" ws)
    (fs/delete-if-exists (workspace-file root))))

;; -- agents ----------------------------------------------------------------

(defn agent-info [name]
  (let [r (cli "agent" "get" name)]
    (when (:ok? r) (get-in r [:result :agent]))))

(defn alive? [name]
  (boolean (agent-info name)))

(defn status
  "idle | working | blocked | done | unknown, or nil when the agent is gone."
  [name]
  (:agent_status (agent-info name)))

(defn record-argv! [file argv]
  (when-let [dir (fs/parent file)]
    (fs/create-dirs dir))
  (spit (str file) (str (pr-str (vec argv)) "\n") :append true))

(defn prompt!
  "Submit `text` to the agent as if typed. Throws when herdr refuses (agent gone or blocked).
   Multi-line text is joined into one line: herdr sends it as a paste, and Claude then
   treats it as pasted content with no request instead of answering it."
  [name text]
  (let [text (one-line text)]
    (if-let [file (stub)]
      (record-argv! file ["herdr" "agent" "prompt" name text])
      (cli! "agent" "prompt" name text))))

(defn read-text
  "Recent terminal text of the agent, or nil."
  [name]
  (let [r (cli "agent" "read" name "--source" "recent-unwrapped" "--lines" read-lines)]
    (when (:ok? r) (:out r))))
