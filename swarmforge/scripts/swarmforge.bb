#!/usr/bin/env bb

(ns swarmforge
  (:require [babashka.fs :as fs]
            [babashka.process :as process]
            [clojure.string :as str]))

(load-file (str (fs/path (fs/parent *file*) "herdr.bb")))

(def red "\u001b[0;31m")
(def green "\u001b[0;32m")
(def yellow "\u001b[1;33m")
(def cyan "\u001b[0;36m")
(def bold "\u001b[1m")
(def reset "\u001b[0m")

(defn sh [& args]
  (apply process/sh args))

(defn sh-ok? [& args]
  (zero? (:exit (apply process/sh (concat [{:continue true}] args)))))

(defn sh-out [& args]
  (str/trim (:out (apply process/sh args))))

(defn command-exists? [command]
  (sh-ok? "sh" "-c" (str "command -v " command " >/dev/null 2>&1")))

(defn fail! [message]
  (binding [*out* *err*]
    (println message))
  (System/exit 1))

(defn sq [value]
  (str "'" (str/replace (str value) #"'" "'\"'\"'") "'"))

(defn display-name-for-role [role]
  (->> (str/split (str/replace role #"[-_]" " ") #"\s+")
       (remove str/blank?)
       (map str/capitalize)
       (str/join " ")))

(defn worktree-path-for-name [worktrees-dir worktree]
  (fs/path worktrees-dir worktree))

(defn ensure-in-file! [file pattern]
  (fs/create-dirs (fs/parent file))
  (when-not (fs/exists? file)
    (spit (str file) ""))
  (let [lines (set (str/split-lines (slurp (str file))))]
    (when-not (contains? lines pattern)
      (spit (str file) (str pattern "\n") :append true))))

(defn ensure-initial-gitignore! [ctx]
  (let [gitignore (fs/path (:working-dir ctx) ".gitignore")]
    (if-not (fs/exists? gitignore)
      (spit (str gitignore) ".swarmforge/\n.worktrees/\n")
      (do
        (ensure-in-file! gitignore ".swarmforge/")
        (ensure-in-file! gitignore ".worktrees/")))))

(defn ensure-runtime-git-excludes! [ctx]
  (let [exclude-file (fs/path (sh-out "git" "-C" (str (:working-dir ctx)) "rev-parse" "--git-path" "info/exclude"))]
    (fs/create-dirs (fs/parent exclude-file))
    (ensure-in-file! exclude-file ".swarmforge/")
    (ensure-in-file! exclude-file ".worktrees/")))

(defn initialize-git-repo! [ctx]
  (when-not (fs/exists? (fs/path (:working-dir ctx) ".git"))
    (sh "git" "init" (str (:working-dir ctx)))
    (sh "git" "-C" (str (:working-dir ctx)) "branch" "-M" "master")
    (ensure-initial-gitignore! ctx)
    (sh "git" "-C" (str (:working-dir ctx)) "add" ".")
    (sh "git" "-C" (str (:working-dir ctx)) "commit" "-m" "Initial swarmforge repository")))

(defn config-fail! [message]
  (fail! (str red "Error:" reset " " message)))

(defn skip-config-line? [line]
  (or (str/blank? line) (str/starts-with? line "#")))

(defn special-worktree? [worktree]
  (#{"none" "master"} worktree))

(defn visible-window? [directive line-no]
  (case directive
    "window" true
    "window-invisible" false
    (config-fail! (str "Unknown config directive on line " line-no ": " directive))))

(def receive-modes #{"task" "batch"})
(def propagation-modes #{"forward-only" "back-one" "back-all"})
(def known-agents #{"claude" "codex" "copilot" "grok"})

(defn receive-fields [trailing]
  (let [[receive-mode after-receive]
        (if (receive-modes (first trailing))
          [(first trailing) (rest trailing)]
          ["task" trailing])
        [propagation extra]
        (if (propagation-modes (first after-receive))
          [(first after-receive) (rest after-receive)]
          ["forward-only" after-receive])]
    [receive-mode propagation extra]))

(defn extra-args-str [tokens]
  (when (seq tokens)
    (str/join " " tokens)))

(defn reject-if [pred message]
  (when pred (config-fail! message)))

(defn validate-window! [ctx line-no role agent worktree receive-mode roles worktrees]
  (reject-if (str/includes? role "_")
             (str "Invalid role '" role "' on line " line-no ": role names may not contain underscores"))
  (reject-if (contains? roles role)
             (str "Duplicate role '" role "' in " (:config-file ctx)))
  (reject-if (and (not (special-worktree? worktree)) (contains? worktrees worktree))
             (str "Duplicate worktree '" worktree "' in " (:config-file ctx)))
  (reject-if (or (str/includes? worktree "/") (#{"." ".."} worktree))
             (str "Invalid worktree '" worktree "' for role '" role "'"))
  (reject-if (not (known-agents agent))
             (str "Unsupported agent '" agent "' for role '" role "'"))
  (reject-if (not (#{"task" "batch"} receive-mode))
             (str "Invalid receive mode '" receive-mode "' for role '" role "' on line " line-no ": expected task or batch"))
  (reject-if (not (fs/exists? (fs/path (:roles-dir ctx) (str role ".prompt"))))
             (str "Missing role prompt " (fs/path (:roles-dir ctx) (str role ".prompt")))))

(defn window-row [ctx role agent worktree receive-mode propagation extra-args visible?]
  {:role role
   :agent agent
   :session (herdr/agent-name (:working-dir ctx) role)
   :display-name (display-name-for-role role)
   :worktree-name worktree
   :worktree-path (if (special-worktree? worktree)
                    (:working-dir ctx)
                    (worktree-path-for-name (:worktrees-dir ctx) worktree))
   :receive-mode receive-mode
   :propagation propagation
   :extra-args extra-args
   :visible? visible?})

(defn parse-window-line [ctx line-no line roles worktrees]
  (let [fields (str/split line #"\s+")]
    (reject-if (< (count fields) 4)
               (str "Invalid config line " line-no ": " line))
    (let [[directive role agent worktree & trailing] fields
          agent (str/lower-case agent)
          [receive-mode propagation extra-tokens] (receive-fields trailing)
          visible? (visible-window? directive line-no)]
      (validate-window! ctx line-no role agent worktree receive-mode roles worktrees)
      (window-row ctx role agent worktree receive-mode propagation (extra-args-str extra-tokens) visible?))))

(defn require-master-worktree! [rows]
  (let [masters (filterv #(= "master" (:worktree-name %)) rows)]
    (reject-if (not= 1 (count masters))
               "Config must name exactly one master worktree")))

(def account-env-vars
  "The environment variable that selects a backend's account (config directory)."
  {"claude" "CLAUDE_CONFIG_DIR"
   "codex" "CODEX_HOME"})

(defn expand-home [path]
  (if (str/starts-with? path "~")
    (str (System/getProperty "user.home") (subs path 1))
    path))

(defn accounts-file []
  (or (not-empty (System/getenv "SWARMFORGE_ACCOUNTS_FILE"))
      (str (fs/path (System/getProperty "user.home") ".config" "swarmforge" "accounts.conf"))))

(defn parse-accounts
  "`account <name> <backend>=<dir> ...` lines -> {name {backend dir}}."
  [text]
  (into {}
        (for [raw (str/split-lines text)
              :let [line (str/trim raw)]
              :when (not (skip-config-line? line))
              :let [[directive name & pairs] (str/split line #"\s+")]]
          (do
            (reject-if (or (not= directive "account") (nil? name))
                       (str "Invalid line in " (accounts-file) ": " line))
            [name (into {}
                        (for [pair pairs
                              :let [[backend dir] (str/split pair #"=" 2)]]
                          (do
                            (reject-if (or (str/blank? backend) (str/blank? dir))
                                       (str "Invalid account entry '" pair "' in " (accounts-file)
                                            "; expected <backend>=<dir>"))
                            [backend (expand-home dir)])))]))))

(defn resolve-account
  "The project's billing account, chosen by SWARMFORGE_ACCOUNT or an `account <name>` line in
   the conf. Adds :account {:name :dirs}; without a choice the agents inherit their environment."
  [ctx]
  (if-let [name (or (not-empty (System/getenv "SWARMFORGE_ACCOUNT")) (:account-name ctx))]
    (let [file (accounts-file)
          _ (reject-if (not (fs/regular-file? file))
                       (str "Account '" name "' is selected but " file " does not exist."))
          dirs (get (parse-accounts (slurp file)) name)]
      (reject-if (nil? dirs) (str "Unknown account '" name "' in " file))
      (assoc ctx :account {:name name :dirs dirs}))
    ctx))

(defn check-account-dirs!
  "Every claude or codex role needs its account directory, already logged in."
  [ctx]
  (when-let [{:keys [name dirs]} (:account ctx)]
    (doseq [agent (distinct (filter account-env-vars (map :agent (:roles ctx))))]
      (let [dir (get dirs agent)]
        (reject-if (nil? dir)
                   (str "Account '" name "' has no " agent " directory, but a role uses " agent "."))
        (reject-if (not (fs/directory? dir))
                   (str "Account '" name "' " agent " directory " dir
                        " does not exist. Log in once with " (account-env-vars agent) "=" dir " " agent "."))))))

(defn parse-account-line [line line-no]
  (let [fields (str/split line #"\s+")]
    (reject-if (or (not= 2 (count fields)) (not (re-matches #"[A-Za-z0-9_-]+" (second fields))))
               (str "Invalid account line " line-no ": " line))
    (second fields)))

(defn parse-config [ctx]
  (when-not (fs/exists? (:config-file ctx))
    (config-fail! (str "Config not found at " (:config-file ctx))))
  (when-not (fs/exists? (:constitution-file ctx))
    (config-fail! (str "Constitution prompt not found at " (:constitution-file ctx))))
  (loop [lines (map-indexed vector (str/split-lines (slurp (str (:config-file ctx)))))
         rows []
         roles #{}
         worktrees #{}
         account nil]
    (if-let [[line-index raw-line] (first lines)]
      (let [line-no (inc line-index)
            line (str/trim raw-line)]
        (cond
          (skip-config-line? line)
          (recur (next lines) rows roles worktrees account)

          (str/starts-with? line "account ")
          (do (reject-if account (str "Duplicate account line " line-no))
              (recur (next lines) rows roles worktrees (parse-account-line line line-no)))

          :else
          (let [row (parse-window-line ctx line-no line roles worktrees)
                worktree (:worktree-name row)]
            (recur (next lines)
                   (conj rows row)
                   (conj roles (:role row))
                   (cond-> worktrees (not (special-worktree? worktree)) (conj worktree))
                   account))))
      (do
        (reject-if (empty? rows)
                   (str "No windows defined in " (:config-file ctx)))
        (require-master-worktree! rows)
        (assoc ctx :roles rows :account-name account)))))

(defn write-sessions-file! [ctx]
  (spit (str (:sessions-file ctx))
        (apply str
               (map-indexed
                (fn [index row]
                  (format "%d\t%s\t%s\t%s\t%s\n"
                          (inc index) (:role row) (:session row) (:display-name row) (:agent row)))
                (:roles ctx)))))

(defn write-roles-file! [ctx]
  (spit (str (:roles-file ctx))
        (apply str
               (for [row (:roles ctx)]
                 (format "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n"
                         (:role row)
                         (:worktree-name row)
                         (:worktree-path row)
                         (:session row)
                         (:display-name row)
                         (:agent row)
                         (:receive-mode row)
                         (:propagation row))))))

(def required-helpers
  ["handoff_lib.bb" "handoff_lib.ts" "swarm_handoff.sh" "swarm_handoff.bb"
   "swarm_tool.sh" "swarm_tool.bb"
   "commit-msg-hook.sh" "commit_msg_hook.ts"
   "merge_and_process.sh" "merge_and_process.ts"
   "ready_for_next.sh" "ready_for_next.ts"
   "done_with_current.sh" "done_with_current.ts"
   "ready_for_next_task.sh" "ready_for_next_task.ts"
   "done_with_current_task.sh" "done_with_current_task.ts"
   "ready_for_next_batch.sh" "ready_for_next_batch.ts"
   "done_with_current_batch.sh" "done_with_current_batch.ts"
   "handoffd.ts" "stop_handoff_daemon.ts" "stop_handoff_daemon.sh"
   "swarmforge.sh" "swarmforge.bb"
   "pack_board.sh" "pack_board.ts"
   "swarmctl.sh" "swarmctl.ts"])

(defn check-helper-scripts! [ctx]
  (doseq [helper required-helpers]
    (let [path (fs/path (:script-dir ctx) helper)]
      (when-not (and (fs/exists? path) (fs/executable? path))
        (fail! (str red "Error:" reset " Required helper script not found or not executable: " path))))))

(defn git-hooks-dir [ctx]
  (let [path (sh-out "git" "-C" (str (:working-dir ctx)) "rev-parse" "--git-path" "hooks")
        dir (fs/path path)]
    (if (fs/absolute? dir)
      dir
      (fs/path (:working-dir ctx) dir))))

(defn install-commit-msg-hook! [ctx]
  (let [dir (git-hooks-dir ctx)
        hook (fs/path dir "commit-msg")
        hook-script (str (fs/absolutize (fs/path (:script-dir ctx) "commit_msg_hook.ts")))]
    (fs/create-dirs dir)
    (spit (str hook)
          (str "#!/usr/bin/env zsh\n"
               "set -euo pipefail\n"
               "exec bun " (sq hook-script) " \"$@\"\n"))
    (fs/set-posix-file-permissions hook "rwxr-xr-x")))

(defn prepare-workspace! [ctx]
  (doseq [dir [(:state-dir ctx) (:notify-dir ctx) (:prompts-dir ctx)
               (:worktrees-dir ctx) (:daemon-dir ctx)]]
    (fs/create-dirs dir))
  (check-helper-scripts! ctx)
  (write-sessions-file! ctx)
  (write-roles-file! ctx))

(defn prepare-worktrees! [ctx]
  (doseq [row (:roles ctx)
          :let [worktree-name (:worktree-name row)
                worktree-path (:worktree-path row)
                branch-name (str "swarmforge-" worktree-name)]
          :when (not (#{"none" "master"} worktree-name))]
    (when-not (or (fs/exists? (fs/path worktree-path ".git"))
                  (fs/directory? (fs/path worktree-path ".git")))
      (sh "git" "-C" (str (:working-dir ctx)) "worktree" "add" "--force" "-B" branch-name (str worktree-path) "HEAD"))))

(defn prepare-handoff-dirs! [ctx]
  (doseq [row (:roles ctx)
          dir ["outbox/tmp" "sent" "failed" "inbox/new" "inbox/in_process" "inbox/completed"]]
    (fs/create-dirs (fs/path (:worktree-path row) ".swarmforge" "handoffs" dir))))

(defn copy-tree-into! [src dest]
  (when (fs/directory? src)
    (fs/create-dirs dest)
    (fs/copy-tree src dest {:replace-existing true})))

(defn sync-worktree-roles! [ctx worktree-path]
  (copy-tree-into! (:roles-dir ctx) (fs/path worktree-path "swarmforge" "roles"))
  (copy-tree-into! (fs/path (:swarm-forge-dir ctx) "constitution")
                   (fs/path worktree-path "swarmforge" "constitution"))
  (when (fs/exists? (:constitution-file ctx))
    (fs/create-dirs (fs/path worktree-path "swarmforge"))
    (fs/copy (:constitution-file ctx)
             (fs/path worktree-path "swarmforge" "constitution.prompt")
             {:replace-existing true})))

(defn sync-worktree-scripts! [ctx]
  (doseq [row (:roles ctx)
          :let [worktree-path (:worktree-path row)]
          :when (not= (str worktree-path) (str (:working-dir ctx)))]
    (let [role-scripts-dir (fs/path worktree-path "swarmforge" "scripts")
          role-state-dir (fs/path worktree-path ".swarmforge")]
      (fs/create-dirs role-scripts-dir)
      (doseq [entry (fs/list-dir (:script-dir ctx))]
        (let [target (fs/path role-scripts-dir (fs/file-name entry))]
          (if (fs/directory? entry)
            (fs/copy-tree entry target {:replace-existing true})
            (fs/copy entry target {:replace-existing true}))))
      (sync-worktree-roles! ctx worktree-path)
      (fs/create-dirs (fs/path role-state-dir "notify"))
      (fs/copy (:sessions-file ctx) (fs/path role-state-dir "sessions.tsv") {:replace-existing true})
      (fs/copy (:roles-file ctx) (fs/path role-state-dir "roles.tsv") {:replace-existing true}))))

(defn check-dependency! [command]
  (when-not (command-exists? command)
    (fail! (str red "Error:" reset " '" command "' is required but not installed."))))

(defn check-backend-dependencies! [ctx]
  (doseq [agent (map :agent (:roles ctx))]
    (check-dependency! agent)))

(defn check-herdr! []
  (check-dependency! "herdr")
  (when-not (:ok? (herdr/cli "workspace" "list"))
    (fail! (str red "Error:" reset " herdr is installed but its server is not running. Start herdr first."))))

(def aps-tool-purpose
  {"gherkin-parser" "APS parsing"
   "ir-dry-checker" "IR DRY"
   "gherkin-mutator" "Gherkin mutation"})

(def role-required-tools
  {"specifier" ["gherkin-parser" "ir-dry-checker"]
   "coder" ["gherkin-parser"]
   "refactorer" ["gherkin-parser"]
   "hardender" ["gherkin-parser" "gherkin-mutator"]
   "architect" ["gherkin-parser" "gherkin-mutator"]
   "QA" ["gherkin-parser"]})

(defn require-ensure-lines [tools]
  (apply str
         (for [tool tools]
           (str "- `" tool "` (" (get aps-tool-purpose tool) "): `swarm_tool.sh require " tool "`\n"
                "  If missing, run exactly: `swarm_tool.sh ensure " tool "`\n"))))

(defn parse-dry-check-lines [tools]
  (str (when (some #{"gherkin-parser"} tools)
         "- Parse with the two-arg form: `gherkin-parser <feature> ./tmp/<stem>.json`\n")
       (when (some #{"ir-dry-checker"} tools)
         "- Dry-check with the two-arg form: `ir-dry-checker <ir> ./tmp/<stem>.dry.json`\n")))

(defn tool-startup-section [role last-role?]
  (let [tools (get role-required-tools role [])]
    (str "## Tool Startup\n\n"
         "- Do not search `$HOME` or run `find` for APS tools.\n"
         (require-ensure-lines tools)
         (parse-dry-check-lines tools)
         "- Write scratch files and handoff drafts in `./tmp/` in the assigned worktree.\n"
         "- Do not use `/tmp` or `.swarmforge/handoffs/outbox/tmp/` as scratch.\n"
         "- Receive with `ready_for_next.sh`. Send with `swarm_handoff.sh ./tmp/<draft>`.\n"
         "- Do not search the tree or `$HOME` for those scripts.\n"
         "- Do not invoke helpers as `./swarmforge/scripts/...`. They are already on PATH.\n"
         "- Board cards live in `.swarmforge/board/tasks.tsv`. Use that card name as `task:`.\n"
         "- Operator task documents live in `tasks/<task-name>.md`. Re-read that file as operator intent. The master agent commits it with the task's first git work.\n"
         "- A retry audit may include remedial comments on named documents. Read those comments as findings.\n"
         "- Do not search the worktree for `.swarmforge/board/tasks.tsv`. That file is on the project (master).\n"
         "- Use TASK_NAME from `ready_for_next.sh` or the inbound `task:` header. For a batch, that name is the top item. The helper fills `task:` from the in-process batch, else the sender-lane card.\n"
         "- Do not invent a name or hunt `sessions.tsv`.\n"
         "- Constitution tools: `swarm_tool.sh require crap4clj` (also dry4clj, clj-mutate, cloverage, speclj, speclj-structure-check, APS, or the language table). If missing, `swarm_tool.sh ensure <tool>`. Do not invent project `bb` proxies.\n"
         "- Run constitution tools one at a time. Worker-limited tools use `--max-workers 4` or `--workers 4`. Mutation is differential: no `--mutate-all`, no `--level full`.\n"
         "- Do not clone those repos into `./tmp`.\n"
         "- If merge_and_process.sh or ready_for_next reports a merge conflict, resolve the conflicted files, git add, and commit. Do not invent git merge. Parallel cards on one tree will conflict; that is expected.\n"
         "- If you are the master agent, ask the operator directly in this pane. Otherwise send a `note` handoff to the master agent with your one-line question; do not ask in your own pane.\n"
         "- Do not ask for approval in the pane. Queue `git_handoff`; the operator approves with `./swarm approve`.\n"
         (when last-role?
           (str "- You are the last role in this pack. After this pack step, queue a git_handoff. The helper marks the card Done. Do not list every other role on to: to finish the card.\n"))
         (when (= role "specifier")
           (str "- Specify from the board card and the current product tree. Do not import behavior from sibling projects.\n"
                "- Do not ask the operator what new feature to specify or what the card already states.\n"
                "- Finish the assigned TASK_NAME and payload (the whole card), then one git_handoff. Do not hand off after the first feature in a folder.\n"))
         (when (= role "QA")
           (str "- One commit is one git_handoff. Do not send two git_handoffs of the same SHA.\n")))))

(defn last-pack-role? [ctx role]
  (= role (:role (last (:roles ctx)))))

(defn write-agent-instruction-file! [ctx role prompt-file last-role?]
  (spit (str prompt-file)
        (str "Read swarmforge/constitution.prompt, then read every file it refers to recursively, and obey all of those instructions.\n"
             "Read swarmforge/roles/" role ".prompt, then read every file it refers to recursively, and follow all of those instructions.\n"
             "\n"
             (tool-startup-section role last-role?))))

(defn extra-args-prefix [row]
  (let [args (:extra-args row)]
    (if (str/blank? args) "" (str args " "))))

(defn extra-has? [row needle]
  (str/includes? (or (:extra-args row) "") needle))

(defn yolo-flag [agent row]
  (case agent
    "codex" (if (extra-has? row "--yolo") "" "--yolo ")
    "copilot" (if (extra-has? row "--yolo") "" "--yolo ")
    "claude" (if (extra-has? row "bypassPermissions") "" "--permission-mode bypassPermissions ")
    ""))

(defn grok-permission-prefix [row]
  "--permission-mode bypassPermissions ")

(defn alt-screen-env [agent row]
  (if (and (= agent "claude")
           (not (extra-has? row "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN")))
    "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1 "
    ""))

(defn no-alt-screen-flag [agent row]
  (if (and (#{"codex" "copilot"} agent)
           (not (extra-has? row "--no-alt-screen")))
    "--no-alt-screen "
    ""))

(defn split-args
  "ponytail: whitespace split, so a quoted extra arg containing spaces is not supported."
  [s]
  (if (str/blank? s) [] (str/split (str/trim s) #"\s+")))

(defn agent-argv [row display role-worktree prompt-file prompt]
  (let [agent (:agent row)
        extra (split-args (:extra-args row))
        pf (str prompt-file)
        wt (str role-worktree)]
    (vec
     (case agent
       "claude" (concat ["--append-system-prompt-file" pf]
                        (split-args (yolo-flag agent row))
                        ["-n" (str "SwarmForge " display)]
                        extra
                        [prompt])
       "codex" (concat ["-C" wt]
                       (split-args (no-alt-screen-flag agent row))
                       (split-args (yolo-flag agent row))
                       extra
                       [prompt])
       "copilot" (concat ["-C" wt]
                         (split-args (no-alt-screen-flag agent row))
                         ["--name" (str "SwarmForge " display)]
                         (split-args (yolo-flag agent row))
                         extra
                         ["-i" prompt])
       "grok" (concat ["--cwd" wt]
                      (split-args (grok-permission-prefix row))
                      extra
                      ["--minimal" "--rules" prompt "--verbatim" prompt])))))

(defn account-env [ctx agent]
  (when-let [dir (get-in ctx [:account :dirs agent])]
    (when-let [var (account-env-vars agent)]
      {var dir})))

(defn launch-spec
  "What to run for a role: `env` is set on the role's pane shell; `argv` goes to
   `herdr agent start --kind <agent>`."
  [ctx row]
  (let [role (:role row)
        agent (:agent row)
        role-worktree (:worktree-path row)
        role-script-dir (if (= (str role-worktree) (str (:working-dir ctx)))
                          (:script-dir ctx)
                          (fs/path role-worktree "swarmforge" "scripts"))
        prompt-file (fs/path (:prompts-dir ctx) (str role ".md"))
        tool-bin (fs/path (:working-dir ctx) ".swarmforge" "bin")]
    (write-agent-instruction-file! ctx role prompt-file (last-pack-role? ctx role))
    (let [prompt (slurp (str prompt-file))]
      {:agent agent
       :prompt prompt
       :prompt-file prompt-file
       :path-dirs [(str tool-bin) (str role-script-dir)]
       :env (cond-> (merge {"SWARMFORGE_ROLE" role} (account-env ctx agent))
              (not (str/blank? (alt-screen-env agent row)))
              (assoc "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN" "1"))
       :argv (agent-argv row (:display-name row) role-worktree prompt-file prompt)})))

(defn codex-home []
  (or (not-empty (System/getenv "CODEX_HOME"))
      (str (fs/path (System/getProperty "user.home") ".codex"))))

(defn project-table-header [dir]
  (str "[projects." (pr-str (str (fs/absolutize dir))) "]"))

(defn ensure-newline [text]
  (cond
    (str/blank? text) ""
    (str/ends-with? text "\n") text
    :else (str text "\n")))

(defn ensure-codex-trust! [dir & [account-home]]
  (when-not (str/blank? (str dir))
    (let [home (or account-home (codex-home))
          cfg (fs/path home "config.toml")
          header (project-table-header dir)
          text (if (fs/exists? cfg) (slurp (str cfg)) "")]
      (when-not (str/includes? text header)
        (fs/create-dirs home)
        (spit (str cfg)
              (str (ensure-newline text)
                   "\n" header "\ntrust_level = \"trusted\"\n"))))))

(defn launch-role!
  "Start `row`'s agent in the pane that `open-pane` (a fn of cwd and env) returns."
  [ctx row open-pane]
  (when (= "codex" (:agent row))
    (ensure-codex-trust! (:worktree-path row) (get-in ctx [:account :dirs "codex"])))
  (let [display (:display-name row)
        {:keys [agent env path-dirs argv]} (launch-spec ctx row)
        pane (open-pane (str (:worktree-path row)) env)
        _ (herdr/label-pane! pane display)
        _ (herdr/prepend-path! pane path-dirs)
        result (herdr/start-agent! (:session row) agent pane argv)]
    (if (:ok? result)
      (println (str "  " cyan "[" display "]" reset " started as " (:session row)))
      (println (str "  " yellow "[" display "]" reset " " (:session row) " is not ready: "
                    (get-in result [:error :message])
                    ". Answer it in herdr; the role keeps running.")))))

(defn stop-handoff-daemon! [ctx]
  (process/sh {:continue true}
              "bun" (str (fs/path (:script-dir ctx) "stop_handoff_daemon.ts"))
              (str (:working-dir ctx))))

(defn uname []
  (str/trim (:out (process/sh {:continue true} "uname" "-s"))))

(defn linux-systemd-running? []
  (let [result (process/sh {:continue true} "systemctl" "is-system-running")
        state (str/trim (:out result))]
    (#{"running" "degraded"} state)))

(defn sleep-inhibitor-prefix []
  (when-not (= "0" (System/getenv "SWARMFORGE_PREVENT_SLEEP"))
    (case (uname)
      "Darwin" (when (command-exists? "caffeinate")
                 ["caffeinate" "-dims"])
      "Linux" (when (and (command-exists? "systemd-inhibit")
                         (command-exists? "systemctl")
                         (linux-systemd-running?))
                ["systemd-inhibit"
                 "--what=sleep:idle"
                 "--who=SwarmForge"
                 "--why=SwarmForge swarm is active"])
      nil)))

(defn start-handoff-daemon! [ctx]
  (fs/delete-if-exists (fs/path (:daemon-dir ctx) "stop"))
  (let [command (into (vec (sleep-inhibitor-prefix))
                      [(str (fs/path (:script-dir ctx) "handoffd.ts"))
                       (str (:working-dir ctx))])]
    (process/process command
                     {:out (str (:handoff-daemon-log ctx))
                      :err :out})
    (println (str green "Started handoff daemon"
                  (when (> (count command) 2) " with OS sleep prevention")
                  "."
                  reset))))

(defn launch-plan-lines [ctx]
  (map #(str "start-agent " (:role %)) (:roles ctx)))

(defn context [working-dir]
  (let [working-dir (fs/absolutize (fs/path working-dir))
        script-dir (fs/parent *file*)
        swarm-forge-dir (fs/path working-dir "swarmforge")
        state-dir (fs/path working-dir ".swarmforge")
        daemon-dir (fs/path state-dir "daemon")]
    {:working-dir working-dir
     :script-dir script-dir
     :swarm-forge-dir swarm-forge-dir
     :worktrees-dir (fs/path working-dir ".worktrees")
     :config-file (fs/path swarm-forge-dir "swarmforge.conf")
     :roles-dir (fs/path swarm-forge-dir "roles")
     :constitution-file (fs/path swarm-forge-dir "constitution.prompt")
     :state-dir state-dir
     :notify-dir (fs/path state-dir "notify")
     :sessions-file (fs/path state-dir "sessions.tsv")
     :roles-file (fs/path state-dir "roles.tsv")
     :prompts-dir (fs/path state-dir "prompts")
     :daemon-dir daemon-dir
     :handoff-daemon-log (fs/path daemon-dir "handoffd.log")}))

(defn prepare-ctx [ctx]
  (let [ctx (-> ctx parse-config resolve-account)]
    (check-account-dirs! ctx)
    ctx))

(defn visibility-label [row]
  (if (:visible? row) "visible" "invisible"))

(defn test-parse! [root]
  (let [ctx (prepare-ctx (context root))]
    (prepare-workspace! ctx)
    (doseq [row (:roles ctx)]
      (println (str (:role row) " " (:display-name row) " " (:worktree-path row) " "
                    (:receive-mode row) " " (:propagation row)
                    (when-let [extra (:extra-args row)] (str " " extra))
                    " " (visibility-label row))))
    (when-let [account (:account ctx)]
      (println "account" (:name account)))
    (print (slurp (str (:roles-file ctx))))
    (print (slurp (str (:sessions-file ctx))))))

(defn test-required-helpers! []
  (doseq [helper required-helpers]
    (println helper)))

(defn test-launch-plan! [root]
  (doseq [line (launch-plan-lines (prepare-ctx (context root)))]
    (println line)))

(defn kill-existing-sessions! [ctx]
  (when (herdr/workspace-id (:working-dir ctx))
    (println (str yellow "Existing SwarmForge workspace found. Closing it..." reset))
    (herdr/close-workspace! (:working-dir ctx))))

(defn announce-ready! [ctx]
  (println)
  (println (str green bold "SwarmForge is ready." reset))
  (println "Working directory:" (str (:working-dir ctx)))
  (when-let [account (:account ctx)]
    (println "Account:" (:name account)))
  (println "Sessions:")
  (doseq [row (:roles ctx)]
    (println (str "  " (:display-name row) ": " (:session row))))
  (println)
  (println (str green "Operate the swarm from this directory:" reset))
  (println "  ./swarm status                              roles, tasks, and what waits for you")
  (println "  ./swarm task new <name> \"description\"      start work: it goes to the master agent")
  (println "  ./swarm approve <id>                        release a spec the specifier submitted")
  (println "  ./swarm reject <id> \"comments\"             send a spec back")
  (println (str green "Talk to the master agent directly in its pane of the herdr workspace '"
                (herdr/project-slug (:working-dir ctx)) "'." reset))
  (println))

(defn launch-roles! [ctx]
  (println (str green "Starting agents..." reset))
  (let [rows (:roles ctx)
        plan (herdr/grid-plan (count rows))
        panes (atom [])]
    (doseq [[i row] (map-indexed vector rows)]
      (launch-role! ctx row
                    (fn [cwd env]
                      (let [pane (if (zero? i)
                                   (herdr/open-workspace! (:working-dir ctx) cwd env)
                                   (let [[from direction ratio] (nth plan (dec i))]
                                     (herdr/split-pane! (nth @panes from) direction ratio cwd env)))]
                        (swap! panes conj pane)
                        pane))))))

(defn boot-sessions! []
  (println (str cyan bold))
  (println "  SwarmForge v1.0 Starting")
  (println "  Disciplined agents build better software")
  (println reset))

(def protected-branches #{"main" "master" "develop"})

(defn current-branch [dir]
  (let [result (process/sh {:continue true} "git" "-C" (str dir) "symbolic-ref" "--short" "-q" "HEAD")]
    (when (zero? (:exit result))
      (str/trim (:out result)))))

(defn check-integration-branch!
  "The master role commits and merges its results directly on the checked-out branch, so a
   protected branch is refused. A repo without commits yet has nothing to protect."
  [ctx]
  (let [dir (:working-dir ctx)
        branch (current-branch dir)]
    (when (and branch
               (protected-branches branch)
               (sh-ok? "git" "-C" (str dir) "rev-parse" "--verify" "-q" "HEAD")
               (not= "1" (System/getenv "SWARMFORGE_ALLOW_BRANCH")))
      (fail! (str red "Error:" reset " Refusing to start on '" branch "'. The swarm's master role commits"
                  " and merges its results directly on the checked-out branch.\n"
                  "Start from an integration branch instead:  git switch -c swarm/<task>\n"
                  "To run on '" branch "' anyway, set SWARMFORGE_ALLOW_BRANCH=1.")))))

(defn run-main! [root]
  (check-herdr!)
  (check-dependency! "git")
  (check-dependency! "bb")
  (check-integration-branch! (context root))
  (let [ctx (context root)]
    (initialize-git-repo! ctx)
    (ensure-runtime-git-excludes! ctx)
    (install-commit-msg-hook! ctx)
    (let [ctx (prepare-ctx ctx)]
      (check-backend-dependencies! ctx)
      (prepare-workspace! ctx)
      (prepare-worktrees! ctx)
      (prepare-handoff-dirs! ctx)
      (stop-handoff-daemon! ctx)
      (kill-existing-sessions! ctx)
      (boot-sessions!)
      (sync-worktree-scripts! ctx)
      (start-handoff-daemon! ctx)
      (launch-roles! ctx)
      (announce-ready! ctx))))

(defn run-stop-project! [root]
  (let [ctx (context root)]
    ;; keep each role's transcript before its pane goes away
    (process/sh {:continue true}
                (str (fs/path (:script-dir ctx) "pack_board.sh"))
                "archive-all" "--root" (str (:working-dir ctx)))
    (stop-handoff-daemon! ctx)
    (herdr/close-workspace! (:working-dir ctx))))

(defn test-branch-check! [root]
  (check-integration-branch! (context root))
  (println "branch ok"))

(defn test-launch-roles! [root]
  (let [ctx (prepare-ctx (context root))]
    (prepare-workspace! ctx)
    (launch-roles! ctx)))

(defn print-launch-spec!
  "Print the pane env, then `herdr agent start --kind <agent> -- <argv>` with the prompt text elided."
  [ctx row]
  (let [{:keys [agent env path-dirs argv prompt]} (launch-spec ctx row)]
    (doseq [[k v] (sort env)]
      (println (str k "=" v)))
    (println (str "PATH=" (str/join ":" path-dirs) ":$PATH"))
    (println (str/join " " (into [(str "kind=" agent) "--"](map #(if (= % prompt) "<prompt>" %) argv))))))

(defn test-launch-command! [root agent & [extra-args]]
  (let [ctx (resolve-account (context root))
        row {:role "coder"
             :agent agent
             :session "sf-coder"
             :display-name "Coder"
             :worktree-name "master"
             :worktree-path (fs/path root)
             :receive-mode "task"
             :extra-args extra-args}]
    (fs/create-dirs (:prompts-dir ctx))
    (print-launch-spec! ctx row)))

(defn test-install-hooks! [root]
  (let [ctx (context root)]
    (install-commit-msg-hook! ctx)
    (println (str (fs/path (git-hooks-dir ctx) "commit-msg")))))

(defn test-sleep-inhibitor-prefix! []
  (println (str/join " " (or (sleep-inhibitor-prefix) []))))

(defn test-ensure-codex-trust! [dir & [home]]
  (ensure-codex-trust! dir home))

(defn -main [& args]
  (case (first args)
    "--test-parse" (test-parse! (or (second args) (System/getProperty "user.dir")))
    "--test-required-helpers" (test-required-helpers!)
    "--test-branch-check" (test-branch-check! (or (second args) (System/getProperty "user.dir")))
    "--test-launch-plan" (test-launch-plan! (or (second args) (System/getProperty "user.dir")))
    "--test-launch-roles" (test-launch-roles! (or (second args) (System/getProperty "user.dir")))
    "--test-launch-command" (apply test-launch-command!
                                     (or (second args) (System/getProperty "user.dir"))
                                     (drop 2 args))
    "--test-install-hooks" (test-install-hooks! (second args))
    "--test-sleep-inhibitor-prefix" (test-sleep-inhibitor-prefix!)
    "--test-ensure-codex-trust" (apply test-ensure-codex-trust! (rest args))
    "--stop-project" (run-stop-project! (second args))
    (run-main! (or (first args) (System/getProperty "user.dir")))))

(when (= (str *file*) (System/getProperty "babashka.file"))
  (apply -main *command-line-args*))
