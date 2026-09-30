(ns swarmforge.script-test
  (:require [babashka.fs :as fs]
            [clojure.java.shell :as sh]
            [clojure.string :as str]
            [clojure.test :refer [deftest is testing]]
            [swarmforge.fake-herdr :as fake-herdr]))

(def repo-root (fs/cwd))
(def scripts-dir (fs/path repo-root "swarmforge" "scripts"))

(defn write-file [path text]
  (fs/create-dirs (fs/parent path))
  (spit (str path) text))

(defn run
  [{:keys [dir env ok?]} & args]
  (let [result (apply sh/sh (concat args [:dir (str dir)
                                          :env (merge {"PATH" (System/getenv "PATH")
                                                       "GIT_CONFIG_NOSYSTEM" "1"}
                                                      (fake-herdr/env dir)
                                                      env)]))]
    (when (and (not (false? ok?)) (not= 0 (:exit result)))
      (throw (ex-info (str "Command failed: " (str/join " " args))
                      (assoc result :args args))))
    result))

(defn init-repo! [root]
  (run {:dir root} "git" "init" "-q")
  (run {:dir root} "git" "config" "user.email" "test@example.com")
  (run {:dir root} "git" "config" "user.name" "Test User")
  (write-file (fs/path root "README.md") "initial\n")
  (run {:dir root} "git" "add" "README.md")
  (run {:dir root} "git" "commit" "-q" "-m" "Initial commit"))

(defn tmp-dir []
  (fs/create-temp-dir {:prefix "swarmforge-script-test."}))

(defn script [name]
  (str (fs/path scripts-dir name)))

(deftest handoff-lib-parses-and-prints-handoff-files
  (let [root (tmp-dir)
        handoff-file (fs/path root "task.handoff")]
    (try
      (write-file handoff-file
                  (str "id: 1\n"
                       "from: coder\n"
                       "to: cleaner\n"
                       "priority: 10\n"
                       "type: git_handoff\n"
                       "task: task-alpha\n"
                       "\n"
                       "merge_and_process coder abcdef1234\n"))
      (let [header (run {:dir root} (script "handoff_lib.bb") "header-field" "task.handoff" "task")
            body (run {:dir root} (script "handoff_lib.bb") "body" "task.handoff")
            task (run {:dir root} (script "handoff_lib.bb") "print-task" "task.handoff")]
        (is (str/includes? (:out header) "task-alpha"))
        (is (str/includes? (:out body) "merge_and_process coder abcdef1234"))
        (is (str/includes? (:out task) "TASK: task.handoff"))
        (is (str/includes? (:out task) "FROM: coder"))
        (is (str/includes? (:out task) "TASK_NAME: task-alpha")))
      (finally
        (fs/delete-tree root)))))

(deftest handoff-lib-updates-headers-and-reads-role-state
  (let [root (tmp-dir)]
    (try
      (init-repo! root)
      (write-file (fs/path root ".swarmforge/roles.tsv")
                  (str "coder\tmaster\t" root "\tsession\tCoder\tcodex\ttask\n"
                       "cleaner\tcleaner\t" root "/.worktrees/cleaner\tsession\tCleaner\tcodex\tbatch\n"))
      (write-file (fs/path root ".swarmforge/handoffs/inbox/new/item.handoff")
                  (str "id: 1\n"
                       "from: coder\n"
                       "to: cleaner\n"
                       "priority: 20\n"
                       "type: note\n"
                       "\n"
                       "payload\n"))
      (run {:dir root} (script "handoff_lib.bb") "role-known" "cleaner")
      (run {:dir root} (script "handoff_lib.bb") "set-header" ".swarmforge/handoffs/inbox/new/item.handoff" "dequeued_at" "2026-06-16T00:00:00Z")
      (let [mode (run {:dir root} (script "handoff_lib.bb") "role-receive-mode" "cleaner")
            worktree (run {:dir root} (script "handoff_lib.bb") "role-worktree-name" "cleaner")
            dequeued (run {:dir root} (script "handoff_lib.bb") "header-field" ".swarmforge/handoffs/inbox/new/item.handoff" "dequeued_at")
            seq-1 (run {:dir root} (script "handoff_lib.bb") "next-sequence")
            seq-2 (run {:dir root} (script "handoff_lib.bb") "next-sequence")]
        (is (str/includes? (:out mode) "batch"))
        (is (str/includes? (:out worktree) "cleaner"))
        (is (str/includes? (:out dequeued) "2026-06-16T00:00:00Z"))
        (is (str/includes? (:out seq-1) "000001"))
        (is (str/includes? (:out seq-2) "000002")))
      (finally
        (fs/delete-tree root)))))

(deftest swarmforge-launcher-parses-config-and-writes-state-files
  (let [root (tmp-dir)]
    (try
      (write-file (fs/path root "swarmforge/constitution.prompt")
                  "Read articles.\n")
      (write-file (fs/path root "swarmforge/swarmforge.conf")
                  (str "# comment\n"
                       "window coder codex master\n"
                       "window cleaner codex cleaner batch\n"))
      (write-file (fs/path root "swarmforge/roles/coder.prompt") "coder\n")
      (write-file (fs/path root "swarmforge/roles/cleaner.prompt") "cleaner\n")
      (let [result (run {:dir root} (script "swarmforge.bb") "--test-parse" (str root))]
        (is (str/includes? (:out result) "coder Coder"))
        (is (str/includes? (:out result) "cleaner Cleaner"))
        (is (str/includes? (:out result) "cleaner batch"))
        (is (re-find #"\bsf-\S+-coder\b" (:out result)))
        (is (re-find #"\bsf-\S+-cleaner\b" (:out result))))
      (finally
        (fs/delete-tree root)))))

(deftest swarmforge-launcher-rejects-invalid-config
  (let [root (tmp-dir)]
    (try
      (write-file (fs/path root "swarmforge/constitution.prompt")
                  "Read articles.\n")
      (write-file (fs/path root "swarmforge/swarmforge.conf")
                  (str "window coder codex master\n"
                       "window coder codex other\n"))
      (write-file (fs/path root "swarmforge/roles/coder.prompt") "coder\n")
      (let [result (run {:dir root :ok? false} (script "swarmforge.bb") "--test-parse" (str root))]
        (is (= 1 (:exit result)))
        (is (str/includes? (:err result) "Duplicate role 'coder'")))
      (finally
        (fs/delete-tree root)))))

(deftest swarmforge-parses-window-invisible
  ;; Given window-invisible specifier codex master
  ;; When --test-parse
  ;; Then specifier is listed and visible? is false
  (let [root (tmp-dir)]
    (try
      (write-file (fs/path root "swarmforge/constitution.prompt")
                  "Read articles.\n")
      (write-file (fs/path root "swarmforge/swarmforge.conf")
                  "window-invisible specifier codex master\n")
      (write-file (fs/path root "swarmforge/roles/specifier.prompt") "specifier\n")
      (let [result (run {:dir root} (script "swarmforge.bb") "--test-parse" (str root))]
        (is (str/includes? (:out result) "specifier"))
        (is (str/includes? (:out result) "invisible")))
      (finally
        (fs/delete-tree root)))))

(deftest swarmforge-required-helpers-include-pack-scripts
  ;; Given the launcher required-helpers list
  ;; When --test-required-helpers
  ;; Then swarmctl.sh and pack_board.sh are listed
  (let [result (run {:dir repo-root} (script "swarmforge.bb") "--test-required-helpers")
        names (set (str/split-lines (str/trim (:out result))))]
    (is (contains? names "swarmctl.sh"))
    (is (contains? names "pack_board.sh"))))

(defn write-pack-conf! [root conf]
  (write-file (fs/path root "swarmforge/constitution.prompt") "Read articles.\n")
  (write-file (fs/path root "swarmforge/swarmforge.conf") conf)
  (write-file (fs/path root "swarmforge/roles/specifier.prompt") "specifier\n")
  (write-file (fs/path root "swarmforge/roles/coder.prompt") "coder\n"))

(deftest swarmforge-launch-plan-starts-every-agent
  ;; Given window-invisible specifier and a visible coder window
  ;; When --test-launch-plan
  ;; Then both roles get an agent, invisible or not
  (let [root (tmp-dir)]
    (try
      (write-pack-conf! root
                        (str "window-invisible specifier codex master\n"
                             "window coder codex coder\n"))
      (let [out (:out (run {:dir root} (script "swarmforge.bb")
                           "--test-launch-plan" (str root)))]
        (is (str/includes? out "start-agent specifier"))
        (is (str/includes? out "start-agent coder")))
      (finally
        (fs/delete-tree root)))))

(deftest launcher-refuses-a-protected-branch-unless-allowed
  ;; Given a repo with a commit on develop
  ;; When the launcher checks the branch
  ;; Then it refuses main, master and develop, accepts an integration branch, honours
  ;; SWARMFORGE_ALLOW_BRANCH=1, and leaves a repo without commits or a non-repo alone
  (let [root (tmp-dir)
        fresh (tmp-dir)
        plain (tmp-dir)
        check (fn [dir & [env]]
                (run {:dir dir :ok? false :env env}
                     (script "swarmforge.bb") "--test-branch-check" (str dir)))]
    (try
      (init-repo! root)
      (doseq [branch ["develop" "main" "master"]]
        (run {:dir root} "git" "checkout" "-q" "-B" branch)
        (let [result (check root)]
          (is (= 1 (:exit result)) branch)
          (is (str/includes? (:err result) (str "Refusing to start on '" branch "'")) branch)
          (is (str/includes? (:err result) "git switch -c swarm/<task>"))))
      (is (= 0 (:exit (check root {"SWARMFORGE_ALLOW_BRANCH" "1"}))))
      (run {:dir root} "git" "checkout" "-q" "-b" "swarm/r-030")
      (is (str/includes? (:out (check root)) "branch ok"))
      (run {:dir fresh} "git" "init" "-q" "-b" "main")
      (is (= 0 (:exit (check fresh))))
      (is (= 0 (:exit (check plain))))
      (finally
        (fs/delete-tree root)
        (fs/delete-tree fresh)
        (fs/delete-tree plain)))))

(deftest swarmforge-launch-gives-each-role-a-pane-and-starts-its-agent
  ;; Given a claude coder on master and a claude cleaner
  ;; When the launcher starts the roles against herdr
  ;; Then one workspace holds a pane per role, and each agent is started by name in its own pane
  (let [root (tmp-dir)]
    (try
      (write-pack-conf! root
                        (str "window coder claude master\n"
                             "window cleaner claude cleaner\n"))
      (write-file (fs/path root "swarmforge/roles/cleaner.prompt") "cleaner\n")
      (let [launched (run {:dir root} (script "swarmforge.bb") "--test-launch-roles" (str root))
            calls (fake-herdr/calls root)
            starts (filter #(str/starts-with? % "agent start") calls)]
        (is (not (str/includes? (:out launched) "is not ready")))
        (is (= 1 (count (filter #(str/starts-with? % "workspace create") calls))))
        (is (empty? (filter #(str/starts-with? % "tab create") calls)))
        (is (= 1 (count (filter #(str/starts-with? % "pane split w1:p1 --direction right --ratio 0.5") calls))))
        (is (some #(and (str/starts-with? % "workspace create")
                        (str/includes? % "--env SWARMFORGE_ROLE=coder")) calls))
        (is (some #(and (str/starts-with? % "pane split")
                        (str/includes? % "--env SWARMFORGE_ROLE=cleaner")) calls))
        (is (some #(re-find #"^pane run w1:p1 export PATH='[^']*/\.swarmforge/bin':" %) calls))
        (is (some #(re-find #"^pane run w1:p2 export PATH='[^']*/\.swarmforge/bin':" %) calls))
        (is (re-find #"^agent start sf-\S+-coder --kind claude --pane w1:p1 " (first starts)))
        (is (re-find #"^agent start sf-\S+-cleaner --kind claude --pane w1:p2 " (second starts)))
        (is (= "w1" (str/trim (slurp (str (fs/path root ".swarmforge/herdr-workspace")))))))
      (finally
        (fs/delete-tree root)))))

(deftest swarmforge-fails-without-a-master-worktree
  ;; Given only window coder codex coder
  ;; When --test-parse
  ;; Then exit 1 and error mentions master
  (let [root (tmp-dir)]
    (try
      (write-file (fs/path root "swarmforge/constitution.prompt")
                  "Read articles.\n")
      (write-file (fs/path root "swarmforge/swarmforge.conf")
                  "window coder codex coder\n")
      (write-file (fs/path root "swarmforge/roles/coder.prompt") "coder\n")
      (let [result (run {:dir root :ok? false} (script "swarmforge.bb") "--test-parse" (str root))]
        (is (= 1 (:exit result)))
        (is (str/includes? (:err result) "master")))
      (finally
        (fs/delete-tree root)))))

(deftest swarmforge-fails-with-two-master-worktrees
  ;; Given two windows whose worktree is master
  ;; When --test-parse
  ;; Then exit 1 and error mentions master
  (let [root (tmp-dir)]
    (try
      (write-file (fs/path root "swarmforge/constitution.prompt")
                  "Read articles.\n")
      (write-file (fs/path root "swarmforge/swarmforge.conf")
                  (str "window specifier codex master\n"
                       "window coder codex master\n"))
      (write-file (fs/path root "swarmforge/roles/specifier.prompt") "specifier\n")
      (write-file (fs/path root "swarmforge/roles/coder.prompt") "coder\n")
      (let [result (run {:dir root :ok? false} (script "swarmforge.bb") "--test-parse" (str root))]
        (is (= 1 (:exit result)))
        (is (str/includes? (:err result) "master")))
      (finally
        (fs/delete-tree root)))))

(deftest swarmforge-sleep-prevention-can-be-disabled
  (let [result (run {:dir repo-root
                     :env {"SWARMFORGE_PREVENT_SLEEP" "0"}}
                    (script "swarmforge.bb")
                    "--test-sleep-inhibitor-prefix")]
    (is (= "" (str/trim (:out result))))))

(deftest swarmforge-launcher-parses-extra-cli-args
  (let [root (tmp-dir)]
    (try
      (write-file (fs/path root "swarmforge/constitution.prompt")
                  "Read articles.\n")
      (write-file (fs/path root "swarmforge/swarmforge.conf")
                  (str "window coder copilot master --yolo\n"
                       "window cleaner copilot cleaner batch --allow-all-tools\n"))
      (write-file (fs/path root "swarmforge/roles/coder.prompt") "coder\n")
      (write-file (fs/path root "swarmforge/roles/cleaner.prompt") "cleaner\n")
      (let [result (run {:dir root} (script "swarmforge.bb") "--test-parse" (str root))]
        (is (str/includes? (:out result) "coder Coder"))
        (is (str/includes? (:out result) "task forward-only --yolo"))
        (is (str/includes? (:out result) "batch forward-only --allow-all-tools")))
      (finally
        (fs/delete-tree root)))))

(deftest swarmforge-parses-propagation-tokens
  ;; Given omitted, back-one, and back-all after receive-mode, plus extra CLI args
  ;; When --test-parse
  ;; Then omitted is forward-only, tokens round-trip in roles.tsv, extra args still apply
  (let [root (tmp-dir)]
    (try
      (write-file (fs/path root "swarmforge/constitution.prompt")
                  "Read articles.\n")
      (write-file (fs/path root "swarmforge/swarmforge.conf")
                  (str "window specifier grok master\n"
                       "window coder grok coder task --yolo\n"
                       "window refactorer grok refactorer task back-one\n"
                       "window architect grok architect batch back-all --allow-all-tools\n"))
      (write-file (fs/path root "swarmforge/roles/specifier.prompt") "specifier\n")
      (write-file (fs/path root "swarmforge/roles/coder.prompt") "coder\n")
      (write-file (fs/path root "swarmforge/roles/refactorer.prompt") "refactorer\n")
      (write-file (fs/path root "swarmforge/roles/architect.prompt") "architect\n")
      (let [result (run {:dir root} (script "swarmforge.bb") "--test-parse" (str root))
            out (:out result)]
        (is (zero? (:exit result)))
        (is (str/includes? out "specifier Specifier"))
        (is (str/includes? out "task forward-only"))
        (is (str/includes? out "task forward-only --yolo"))
        (is (str/includes? out "task back-one"))
        (is (str/includes? out "batch back-all --allow-all-tools"))
        (let [roles (slurp (str (fs/path root ".swarmforge/roles.tsv")))
              lines (str/split-lines roles)]
          (is (str/ends-with? (first lines) "\ttask\tforward-only"))
          (is (str/includes? (nth lines 1) "\ttask\tforward-only"))
          (is (str/ends-with? (nth lines 2) "\ttask\tback-one"))
          (is (str/ends-with? (nth lines 3) "\tbatch\tback-all"))))
      (finally
        (fs/delete-tree root)))))

(deftest handoff-lib-reads-role-propagation
  (let [root (tmp-dir)]
    (try
      (init-repo! root)
      (write-file (fs/path root ".swarmforge/roles.tsv")
                  (str "coder\tmaster\t" root "\tsession\tCoder\tcodex\ttask\n"
                       "cleaner\tcleaner\t" root "\tsession\tCleaner\tcodex\tbatch\tback-one\n"
                       "architect\tarchitect\t" root "\tsession\tArchitect\tcodex\tbatch\tback-all\n"))
      (let [coder (run {:dir root} (script "handoff_lib.bb") "role-propagation" "coder")
            cleaner (run {:dir root} (script "handoff_lib.bb") "role-propagation" "cleaner")
            architect (run {:dir root} (script "handoff_lib.bb") "role-propagation" "architect")]
        (is (str/includes? (:out coder) "forward-only"))
        (is (str/includes? (:out cleaner) "back-one"))
        (is (str/includes? (:out architect) "back-all")))
      (finally
        (fs/delete-tree root)))))

(deftest copilot-launch-command-passes-extra-cli-args
  (let [root (tmp-dir)]
    (try
      (let [result (run {:dir root}
                        (script "swarmforge.bb")
                        "--test-launch-command"
                        (str root)
                        "copilot"
                        "--yolo")
            command (:out result)]
        (is (str/includes? command "kind=copilot -- -C "))
        (is (re-find #"--name SwarmForge Coder --yolo -i" command)))
      (finally
        (fs/delete-tree root)))))

(deftest grok-launch-command-passes-initial-prompt
  (let [root (tmp-dir)]
    (try
      (let [result (run {:dir root}
                        (script "swarmforge.bb")
                        "--test-launch-command"
                        (str root)
                        "grok")
            command (:out result)]
        (is (str/includes? command "kind=grok -- --cwd "))
        (is (str/includes? command "--permission-mode bypassPermissions"))
        (is (str/includes? command "--rules <prompt>"))
        (is (str/includes? command "--verbatim <prompt>"))
        (is (fs/exists? (fs/path root ".swarmforge/prompts/coder.md"))))
      (finally
        (fs/delete-tree root)))))

(deftest grok-launch-command-uses-minimal-for-scrollback
  ;; Given a grok pack role
  ;; When SwarmForge builds the launch command
  ;; Then grok runs --minimal so finalized chatter is in scrollback
  (let [root (tmp-dir)]
    (try
      (let [command (:out (run {:dir root}
                               (script "swarmforge.bb")
                               "--test-launch-command"
                               (str root)
                               "grok"))]
        (is (str/includes? command " --minimal ")))
      (finally
        (fs/delete-tree root)))))

(deftest launch-command-puts-transcript-in-scrollback
  ;; Given each pack backend
  ;; When SwarmForge builds the launch command
  ;; Then Codex and Copilot use --no-alt-screen, Claude disables the
  ;; alternate screen, and Grok keeps --minimal
  (doseq [[agent needle] [["codex" "--no-alt-screen"]
                          ["copilot" "--no-alt-screen"]
                          ["claude" "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1"]
                          ["grok" "--minimal"]]]
    (let [root (tmp-dir)]
      (try
        (let [command (:out (run {:dir root}
                                 (script "swarmforge.bb")
                                 "--test-launch-command"
                                 (str root)
                                 agent))]
          (is (str/includes? command needle) agent))
        (finally
          (fs/delete-tree root))))))

(deftest grok-launch-command-uses-bypass-permissions-with-always-approve
  (let [root (tmp-dir)]
    (try
      (let [result (run {:dir root}
                        (script "swarmforge.bb")
                        "--test-launch-command"
                        (str root)
                        "grok"
                        "--always-approve")
            command (:out result)]
        (is (str/includes? command "--permission-mode bypassPermissions"))
        (is (str/includes? command "--always-approve"))
        (is (not (str/includes? command "--permission-mode acceptEdits"))))
      (finally
        (fs/delete-tree root)))))

(deftest launch-command-yolos-every-backend
  ;; Given a pack role with no extra-args
  ;; When --test-launch-command for each backend
  ;; Then the start command bypasses permission prompts
  (doseq [[agent needle] [["codex" "--yolo"]
                          ["copilot" "--yolo"]
                          ["claude" "--permission-mode bypassPermissions"]
                          ["grok" "--permission-mode bypassPermissions"]]]
    (let [root (tmp-dir)]
      (try
        (let [command (:out (run {:dir root}
                                 (script "swarmforge.bb")
                                 "--test-launch-command"
                                 (str root)
                                 agent))]
          (is (str/includes? command needle) agent))
        (finally
          (fs/delete-tree root))))))

(deftest launch-command-puts-project-tool-bin-on-path
  ;; Given a launched role
  ;; When the start command is built
  ;; Then `.swarmforge/bin` is on PATH so require/ensure wrappers are found
  (let [root (tmp-dir)]
    (try
      (let [command (:out (run {:dir root}
                               (script "swarmforge.bb")
                               "--test-launch-command"
                               (str root)
                               "codex"))]
        (is (str/includes? command ".swarmforge/bin:")))
      (finally
        (fs/delete-tree root)))))

(deftest swarmforge-trusts-codex-worktree-once
  ;; Given a Codex worktree with no projects block
  ;; When startup ensures trust
  ;; Then config.toml gains trust_level trusted for that exact path, once
  (let [root (tmp-dir)
        home (fs/create-temp-dir {:prefix "codex-home."})
        wt (str (fs/absolutize root))]
    (try
      (doseq [_ [1 2]]
        (run {:dir root :env {"CODEX_HOME" (str home)
                              "HOME" (str home)
                              "PATH" (System/getenv "PATH")
                              "GIT_CONFIG_NOSYSTEM" "1"}}
             (script "swarmforge.bb")
             "--test-ensure-codex-trust"
             wt))
      (let [cfg (slurp (str (fs/path home "config.toml")))
            header (str "[projects." (pr-str wt) "]")
            hits (count (re-seq (re-pattern (java.util.regex.Pattern/quote header)) cfg))]
        (is (str/includes? cfg header))
        (is (str/includes? cfg "trust_level = \"trusted\""))
        (is (= 1 hits)))
      (finally
        (fs/delete-tree root)
        (fs/delete-tree home)))))

(deftest swarmforge-does-not-overwrite-existing-codex-project-block
  ;; Given an existing projects block for the worktree
  ;; When startup ensures trust
  ;; Then that block is left unchanged
  (let [root (tmp-dir)
        home (fs/create-temp-dir {:prefix "codex-home."})
        wt (str (fs/absolutize root))
        header (str "[projects." (pr-str wt) "]")
        original (str header "\ntrust_level = \"untrusted\"\nnote = \"keep\"\n")]
    (try
      (write-file (fs/path home "config.toml") original)
      (run {:dir root :env {"CODEX_HOME" (str home)
                            "PATH" (System/getenv "PATH")
                            "GIT_CONFIG_NOSYSTEM" "1"}}
           (script "swarmforge.bb")
           "--test-ensure-codex-trust"
           wt)
      (is (= original (slurp (str (fs/path home "config.toml")))))
      (finally
        (fs/delete-tree root)
        (fs/delete-tree home)))))

(deftest swarmforge-trust-does-not-duplicate-existing-config
  ;; Given a config.toml that already has another project table
  ;; When startup trusts a new worktree
  ;; Then the old table appears once and the new path appears once
  (let [root (tmp-dir)
        home (fs/create-temp-dir {:prefix "codex-home."})
        wt (str (fs/absolutize root))
        other "[projects.\"/other\"]\ntrust_level = \"trusted\"\n"]
    (try
      (write-file (fs/path home "config.toml") (str "model = \"gpt-5.5\"\n\n" other))
      (run {:dir root :env {"CODEX_HOME" (str home)
                            "PATH" (System/getenv "PATH")
                            "GIT_CONFIG_NOSYSTEM" "1"}}
           (script "swarmforge.bb")
           "--test-ensure-codex-trust"
           wt)
      (let [cfg (slurp (str (fs/path home "config.toml")))]
        (is (= 1 (count (re-seq #"model = \"gpt-5.5\"" cfg))))
        (is (= 1 (count (re-seq #"\[projects\.\"/other\"\]" cfg))))
        (is (= 1 (count (re-seq (re-pattern (java.util.regex.Pattern/quote
                                             (str "[projects." (pr-str wt) "]")))
                                cfg)))))
      (finally
        (fs/delete-tree root)
        (fs/delete-tree home)))))

(deftest swarm-tool-knows-constitution-tool-names
  ;; Given a pack project
  ;; When require runs for clj-mutate
  ;; Then it is a known tool (missing until ensure), not Unknown tool
  (let [root (tmp-dir)]
    (try
      (write-file (fs/path root ".swarmforge/roles.tsv")
                  (format "specifier\tmaster\t%s\tsession\tSpecifier\tcodex\ttask\n" root))
      (let [missing (run {:dir root :ok? false}
                         (script "swarm_tool.sh") "require" "clj-mutate")
            help (run {:dir root :ok? false}
                      (script "swarm_tool.sh") "--help")]
        (is (not= 0 (:exit missing)))
        (is (str/includes? (:err missing) "MISSING: clj-mutate"))
        (is (not (str/includes? (:err missing) "Unknown tool")))
        (is (str/includes? (str (:err help) (:out help)) "clj-mutate"))
        (is (str/includes? (str (:err help) (:out help)) "crap4clj"))
        (is (str/includes? (str (:err help) (:out help)) "dry4clj"))
        (is (str/includes? (str (:err help) (:out help)) "cloverage"))
        (is (str/includes? (str (:err help) (:out help)) "speclj"))
        (is (str/includes? (str (:err help) (:out help)) "speclj-structure-check")))
      (finally
        (fs/delete-tree root)))))

(deftest swarm-tool-ensure-installs-exec-wrappers-for-jscpd-and-lizard
  ;; Given a pack project
  ;; When ensure runs for jscpd and lizard
  ;; Then each gets a wrapper that runs it through pnpm dlx or uvx, and require then succeeds
  (let [root (tmp-dir)]
    (try
      (write-file (fs/path root ".swarmforge/roles.tsv")
                  (format "specifier\tmaster\t%s\tsession\tSpecifier\tcodex\ttask\n" root))
      (doseq [[tool command] [["jscpd" "exec pnpm dlx jscpd \"$@\""]
                              ["lizard" "exec uvx lizard \"$@\""]]]
        (run {:dir root} (script "swarm_tool.sh") "ensure" tool)
        (is (str/includes? (slurp (str (fs/path root ".swarmforge/bin" tool))) command) tool)
        (is (str/includes? (:out (run {:dir root} (script "swarm_tool.sh") "require" tool)) "OK:") tool))
      (finally
        (fs/delete-tree root)))))

(deftest swarm-tool-ensure-cloverage-invokes-cloverage
  ;; Given a pack project
  ;; When swarm_tool.sh ensure cloverage
  ;; Then the wrapper launches cloverage.coverage, not crap4clj
  (let [root (tmp-dir)]
    (try
      (write-file (fs/path root ".swarmforge/roles.tsv")
                  (format "specifier\tmaster\t%s\tsession\tSpecifier\tcodex\ttask\n" root))
      (run {:dir root} (script "swarm_tool.sh") "ensure" "cloverage")
      (let [wrapper (slurp (str (fs/path root ".swarmforge/bin/cloverage")))]
        (is (str/includes? wrapper "cloverage.coverage"))
        (is (str/includes? wrapper "cloverage/cloverage"))
        (is (str/includes? wrapper "\"src\""))
        (is (str/includes? wrapper "\"spec\""))
        (is (str/includes? wrapper "\"test\""))
        (is (str/includes? wrapper "-s spec"))
        (is (str/includes? wrapper "-r speclj"))
        (is (str/includes? wrapper "speclj/speclj"))
        (is (not (str/includes? wrapper "crap4clj")))
        (is (zero? (:exit (run {:dir root} (script "swarm_tool.sh") "require" "cloverage"))))
        (is (zero? (:exit (run {:dir root} (script "swarm_tool.sh") "require" "Cloverage")))))
      (finally
        (fs/delete-tree root)))))

(deftest swarm-tool-ensure-speclj-uses-speclj-main
  ;; Given a pack project
  ;; When swarm_tool.sh ensure speclj
  ;; Then the wrapper runs speclj.main -c spec, not speclj.cli
  (let [root (tmp-dir)]
    (try
      (write-file (fs/path root ".swarmforge/roles.tsv")
                  (format "specifier\tmaster\t%s\tsession\tSpecifier\tcodex\ttask\n" root))
      (run {:dir root} (script "swarm_tool.sh") "ensure" "speclj")
      (let [wrapper (slurp (str (fs/path root ".swarmforge/bin/speclj")))]
        (is (str/includes? wrapper "speclj.main"))
        (is (str/includes? wrapper "-c spec"))
        (is (str/includes? wrapper "3.13.0"))
        (is (not (str/includes? wrapper "speclj.cli"))))
      (finally
        (fs/delete-tree root)))))

(deftest swarm-tool-ensure-crap4clj-also-installs-cloverage
  ;; Given a pack project with local crap4clj source
  ;; When swarm_tool.sh ensure crap4clj
  ;; Then both crap4clj and cloverage wrappers are installed
  (let [root (tmp-dir)]
    (try
      (write-file (fs/path root ".swarmforge/roles.tsv")
                  (format "specifier\tmaster\t%s\tsession\tSpecifier\tcodex\ttask\n" root))
      (write-file (fs/path root ".swarmforge/tools/crap4clj/bb.edn")
                  "{:tasks {crap4clj identity}}\n")
      (run {:dir root} (script "swarm_tool.sh") "ensure" "crap4clj")
      (is (fs/executable? (fs/path root ".swarmforge/bin/crap4clj")))
      (is (fs/executable? (fs/path root ".swarmforge/bin/cloverage")))
      (is (str/includes? (slurp (str (fs/path root ".swarmforge/bin/cloverage")))
                         "cloverage.coverage"))
      (finally
        (fs/delete-tree root)))))

(deftest swarm-tool-ensure-clj-mutate-also-installs-cloverage
  ;; Given a pack project with local clj-mutate source
  ;; When swarm_tool.sh ensure clj-mutate
  ;; Then both clj-mutate and cloverage wrappers are installed
  (let [root (tmp-dir)]
    (try
      (write-file (fs/path root ".swarmforge/roles.tsv")
                  (format "specifier\tmaster\t%s\tsession\tSpecifier\tcodex\ttask\n" root))
      (write-file (fs/path root ".swarmforge/tools/clj-mutate/bb.edn")
                  "{:tasks {clj-mutate identity}}\n")
      (run {:dir root} (script "swarm_tool.sh") "ensure" "clj-mutate")
      (is (fs/executable? (fs/path root ".swarmforge/bin/clj-mutate")))
      (is (fs/executable? (fs/path root ".swarmforge/bin/cloverage")))
      (is (str/includes? (slurp (str (fs/path root ".swarmforge/bin/cloverage")))
                         "cloverage.coverage"))
      (finally
        (fs/delete-tree root)))))

(deftest swarm-tool-require-and-ensure-install-aps-wrappers
  ;; Given a project without APS tools
  ;; When require runs, it reports missing
  ;; When ensure runs against a local APS source, wrappers land in .swarmforge/bin
  (let [root (tmp-dir)
        aps (fs/path root "aps-src")]
    (try
      (write-file (fs/path root ".swarmforge/roles.tsv")
                  (format "specifier\tmaster\t%s\tsession\tSpecifier\tcodex\ttask\n" root))
      (write-file (fs/path aps "bb.edn") "{:tasks {gherkin-parser identity\n  gherkin-ir-dry-checker identity}}\n")
      (let [missing (run {:dir root :ok? false}
                         (script "swarm_tool.sh") "require" "gherkin-parser")]
        (is (not= 0 (:exit missing)))
        (is (str/includes? (:err missing) "MISSING: gherkin-parser")))
      (run {:dir root
            :env {"SWARMFORGE_TOOL_SRC" (str aps)
                  "PATH" (System/getenv "PATH")
                  "GIT_CONFIG_NOSYSTEM" "1"}}
           (script "swarm_tool.sh") "ensure" "gherkin-parser")
      (run {:dir root
            :env {"SWARMFORGE_TOOL_SRC" (str aps)
                  "PATH" (System/getenv "PATH")
                  "GIT_CONFIG_NOSYSTEM" "1"}}
           (script "swarm_tool.sh") "ensure" "ir-dry-checker")
      (let [parser (fs/path root ".swarmforge/bin/gherkin-parser")
            dry (fs/path root ".swarmforge/bin/ir-dry-checker")]
        (is (fs/executable? parser))
        (is (fs/executable? dry))
        (is (zero? (:exit (run {:dir root} (script "swarm_tool.sh") "require" "gherkin-parser"))))
        (is (zero? (:exit (run {:dir root} (script "swarm_tool.sh") "require" "ir-dry-checker")))))
      (finally
        (fs/delete-tree root)))))

(defn commit-body [root]
  (:out (run {:dir root} "git" "log" "-1" "--format=%B")))

(deftest commit-msg-hook-adds-missing-role-byline
  ;; Given a specifier commit whose message has no byline
  ;; When the commit-msg hook runs
  ;; Then it appends `By specifier.` and does not duplicate an existing byline
  (let [root (tmp-dir)]
    (try
      (init-repo! root)
      (write-file (fs/path root ".swarmforge/roles.tsv")
                  (format "specifier\tmaster\t%s\tsession\tSpecifier\tcodex\ttask\n" root))
      (run {:dir root}
           (script "swarmforge.bb")
           "--test-install-hooks"
           (str root))
      (write-file (fs/path root "spec.md") "hunt\n")
      (run {:dir root} "git" "add" "spec.md")
      (run {:dir root :env {"SWARMFORGE_ROLE" "specifier"
                            "PATH" (System/getenv "PATH")
                            "GIT_CONFIG_NOSYSTEM" "1"}}
           "git" "commit" "-q" "-m" "Specify Hunt the Wumpus console app")
      (let [body (commit-body root)]
        (is (str/includes? body "Specify Hunt the Wumpus console app"))
        (is (str/includes? body "By specifier."))
        (is (= 1 (count (re-seq #"By specifier\." body)))))
      (write-file (fs/path root "spec.md") "hunt two\n")
      (run {:dir root} "git" "add" "spec.md")
      (run {:dir root :env {"SWARMFORGE_ROLE" "specifier"
                            "PATH" (System/getenv "PATH")
                            "GIT_CONFIG_NOSYSTEM" "1"}}
           "git" "commit" "-q" "-m" "Add a scenario\n\nBy specifier.")
      (is (= 1 (count (re-seq #"By specifier\." (commit-body root)))))
      (finally
        (fs/delete-tree root)))))

(deftest commit-msg-hook-infers-role-from-worktree
  ;; Given SWARMFORGE_ROLE is unset and roles.tsv maps this worktree to specifier
  ;; When a commit is made
  ;; Then the hook still adds `By specifier.`
  (let [root (tmp-dir)]
    (try
      (init-repo! root)
      (write-file (fs/path root ".swarmforge/roles.tsv")
                  (format "specifier\tmaster\t%s\tsession\tSpecifier\tcodex\ttask\n" root))
      (run {:dir root}
           (script "swarmforge.bb")
           "--test-install-hooks"
           (str root))
      (write-file (fs/path root "spec.md") "hunt\n")
      (run {:dir root} "git" "add" "spec.md")
      (run {:dir root} "git" "commit" "-q" "-m" "Specify Hunt the Wumpus console app")
      (is (str/includes? (commit-body root) "By specifier."))
      (finally
        (fs/delete-tree root)))))

(defn close-swarm []
  (str (fs/path repo-root "close-swarm")))

(deftest close-swarm-reports-when-no-swarm-state
  (let [root (tmp-dir)]
    (try
      (let [result (run {:dir root :ok? false}
                        (close-swarm)
                        (str root))]
        (is (not= 0 (:exit result)))
        (is (str/includes? (str (:err result) (:out result)) "No SwarmForge swarm")))
      (finally
        (fs/delete-tree root)))))

(deftest close-swarm-closes-the-workspace-and-stops-daemon
  (let [root (tmp-dir)
        pid-file (fs/path root ".swarmforge/daemon/handoffd.pid")
        daemon (.start (java.lang.ProcessBuilder. ["sleep" "120"]))
        pid (str (.pid daemon))]
    (try
      (write-file (fs/path root ".swarmforge/herdr-workspace") "w7\n")
      (write-file pid-file (str pid "\n"))
      (let [result (run {:dir root} (close-swarm) (str root))]
        (is (= 0 (:exit result)))
        (is (= ["w7"] (fake-herdr/closed root)))
        (is (not (fs/exists? (fs/path root ".swarmforge/herdr-workspace"))))
        (is (not (fs/exists? pid-file)))
        (is (false? (.isAlive daemon))))
      (finally
        (when (.isAlive daemon)
          (.destroyForcibly daemon))
        (fs/delete-tree root)))))

(defn write-echo-tool! [root tool]
  (write-file (fs/path root ".swarmforge/roles.tsv")
              (format "specifier\tmaster\t%s\tsession\tSpecifier\tcodex\ttask\n" root))
  (write-file (fs/path root ".swarmforge/tools" tool "bb.edn")
              (str "{:tasks {" tool " (apply println *command-line-args*)}}\n")))

(deftest clj-mutate-wrapper-is-differential-with-four-workers
  ;; Given an installed clj-mutate wrapper
  ;; When it is invoked with --mutate-all
  ;; Then --mutate-all is dropped and --max-workers 4 is used
  (let [root (tmp-dir)]
    (try
      (write-echo-tool! root "clj-mutate")
      (run {:dir root} (script "swarm_tool.sh") "ensure" "clj-mutate")
      (let [out (:out (run {:dir root}
                           (str (fs/path root ".swarmforge/bin/clj-mutate"))
                           "src/htw/game.clj" "--reuse-lcov" "--mutate-all"
                           "--test-command" "bb test"))]
        (is (str/includes? out "--max-workers 4"))
        (is (not (str/includes? out "--mutate-all"))))
      (finally
        (fs/delete-tree root)))))

(deftest clj-mutate-scan-does-not-inject-max-workers
  ;; Given an installed clj-mutate wrapper
  ;; When it is invoked with --scan
  ;; Then it does not add --max-workers
  (let [root (tmp-dir)]
    (try
      (write-echo-tool! root "clj-mutate")
      (run {:dir root} (script "swarm_tool.sh") "ensure" "clj-mutate")
      (let [out (:out (run {:dir root}
                           (str (fs/path root ".swarmforge/bin/clj-mutate"))
                           "src/htw/game.clj" "--scan"))]
        (is (not (str/includes? out "--max-workers"))))
      (finally
        (fs/delete-tree root)))))

(deftest gherkin-mutator-wrapper-is-differential-with-four-workers
  ;; Given an installed gherkin-mutator wrapper
  ;; When it is invoked with --level full
  ;; Then the level is hard and --workers 4 is used
  (let [root (tmp-dir)
        aps (fs/path root "aps-src")]
    (try
      (write-file (fs/path root ".swarmforge/roles.tsv")
                  (format "specifier\tmaster\t%s\tsession\tSpecifier\tcodex\ttask\n" root))
      (write-file (fs/path aps "bb.edn")
                  "{:tasks {gherkin-mutator (apply println *command-line-args*)}}\n")
      (run {:dir root :env {"SWARMFORGE_TOOL_SRC" (str aps)
                            "PATH" (System/getenv "PATH")
                            "GIT_CONFIG_NOSYSTEM" "1"}}
           (script "swarm_tool.sh") "ensure" "gherkin-mutator")
      (let [out (:out (run {:dir root}
                           (str (fs/path root ".swarmforge/bin/gherkin-mutator"))
                           "--feature" "features/a.feature" "--level" "full"
                           "--runner-worker" "true"))]
        (is (str/includes? out "--level hard"))
        (is (str/includes? out "--workers 4"))
        (is (not (str/includes? out "--level full"))))
      (finally
        (fs/delete-tree root)))))

(deftest constitution-tool-wrappers-do-not-use-a-lock-file
  ;; Given an installed constitution tool wrapper
  ;; When it is written
  ;; Then it does not take a project lock directory
  (let [root (tmp-dir)]
    (try
      (write-file (fs/path root ".swarmforge/roles.tsv")
                  (format "specifier\tmaster\t%s\tsession\tSpecifier\tcodex\ttask\n" root))
      (write-file (fs/path root ".swarmforge/tools/crap4clj/bb.edn")
                  "{:tasks {crap4clj identity}}\n")
      (run {:dir root} (script "swarm_tool.sh") "ensure" "crap4clj")
      (let [wrapper (slurp (str (fs/path root ".swarmforge/bin/crap4clj")))]
        (is (not (str/includes? wrapper "constitution-tools.lock")))
        (is (not (str/includes? wrapper "SWARMFORGE_TOOL_HELD"))))
      (finally
        (fs/delete-tree root)))))

(deftest ready-for-next-treats-blank-receive-mode-as-task
  (let [root (tmp-dir)]
    (try
      (init-repo! root)
      (write-file (fs/path root ".swarmforge/roles.tsv")
                  (format "sender\tmaster\t%s\tsession\tSender\tcodex\t\n" root))
      (doseq [dir [".swarmforge/handoffs/outbox/tmp"
                   ".swarmforge/handoffs/sent"
                   ".swarmforge/handoffs/failed"
                   ".swarmforge/handoffs/inbox/new"
                   ".swarmforge/handoffs/inbox/in_process"
                   ".swarmforge/handoffs/inbox/completed"]]
        (fs/create-dirs (fs/path root dir)))
      (let [mode (run {:dir root :env {"SWARMFORGE_ROLE" "sender"}}
                      (script "handoff_lib.bb") "role-receive-mode" "sender")
            ready (run {:dir root :env {"SWARMFORGE_ROLE" "sender"} :ok? false}
                       (script "ready_for_next.sh"))]
        (is (str/includes? (:out mode) "task"))
        (is (zero? (:exit ready)))
        (is (str/includes? (:out ready) "NO_TASK")))
      (write-file (fs/path root ".swarmforge/handoffs/inbox/in_process/50_item.handoff")
                  (str "id: 1\n"
                       "from: sender\n"
                       "to: sender\n"
                       "priority: 50\n"
                       "type: note\n"
                       "task: HTW\n"
                       "\n"
                       "body\n"))
      (let [done (run {:dir root :env {"SWARMFORGE_ROLE" "sender"} :ok? false}
                      (script "done_with_current.sh"))]
        (is (zero? (:exit done)))
        (is (str/includes? (:out done) "COMPLETED:"))
        (is (re-find #"MAIL_WAITING|NO_TASK" (:out done))))
      (finally
        (fs/delete-tree root)))))

(deftest ready-for-next-unknown-role-fails
  (let [root (tmp-dir)]
    (try
      (init-repo! root)
      (write-file (fs/path root ".swarmforge/roles.tsv")
                  (format "sender\tmaster\t%s\tsession\tSender\tcodex\ttask\n" root))
      (let [ready (run {:dir root :env {"SWARMFORGE_ROLE" "ghost"} :ok? false}
                       (script "ready_for_next.sh"))
            done (run {:dir root :env {"SWARMFORGE_ROLE" "ghost"} :ok? false}
                      (script "done_with_current.sh"))]
        (is (not (zero? (:exit ready))))
        (is (str/includes? (str (:err ready) (:out ready)) "Unknown role"))
        (is (not (zero? (:exit done))))
        (is (str/includes? (str (:err done) (:out done)) "Unknown role")))
      (finally
        (fs/delete-tree root)))))

(deftest finish-done-logs-archive-throw-and-still-announces
  (let [root (tmp-dir)
        lib (fs/path root "handoff_lib.bb")]
    (try
      (init-repo! root)
      (write-file (fs/path root ".swarmforge/roles.tsv")
                  (format "sender\tmaster\t%s\tsession\tSender\tcodex\ttask\n" root))
      (fs/create-dirs (fs/path root ".swarmforge/handoffs/inbox/new"))
      (fs/copy (script "handoff_lib.bb") lib)
      (let [result (run {:dir root :env {"SWARMFORGE_ROLE" "sender"} :ok? false}
                        "bb" (str lib) "finish-done")]
        (is (zero? (:exit result)))
        (is (re-find #"MAIL_WAITING|NO_TASK" (:out result)))
        (is (str/includes? (str (:err result)) "archive failed"))
        (is (str/includes? (str (:err result)) "sender"))
        (is (str/includes? (str (:err result)) (str root))))
      (finally
        (fs/delete-tree root)))))

(deftest get-swarm-forge-composes-mini-forge-from-main-and-the-pack
  ;; Given main (runtime, shared articles) and a mini-forge pack tree
  ;; When get-swarm-forge mini-forge runs in a project
  ;; Then the project gets main's runtime and shared articles plus the pack's launcher, conf and roles
  (let [project (tmp-dir)
        base (tmp-dir)
        pack (tmp-dir)]
    (try
      (doseq [name ["swarmforge.sh" "handoffd.bb" "done_with_current.sh"]]
        (write-file (fs/path base "swarmforge/scripts" name) (str name "\n")))
      (doseq [article ["engineering" "workflow" "handoffs"]]
        (write-file (fs/path base "swarmforge/constitution/articles" (str article ".prompt"))
                    (str "MAIN-" article "\n")))
      (write-file (fs/path pack "swarm") "#!/bin/sh\necho pack-swarm\n")
      (write-file (fs/path pack "swarmforge/swarmforge.conf") "window specifier claude master\n")
      (write-file (fs/path pack "swarmforge/constitution.prompt") "PACK-CONSTITUTION\n")
      (write-file (fs/path pack "swarmforge/roles/specifier.prompt") "specifier\n")
      (write-file (fs/path pack "swarmforge/constitution/articles/project.prompt") "PACK-PROJECT\n")
      (write-file (fs/path pack "swarmforge/constitution/articles/engineering.prompt") "PACK-STALE\n")
      (let [result (run {:dir project
                         :env {"SWARMFORGE_BASE_DIR" (str base)
                               "SWARMFORGE_PACKS_DIR" (str pack)}}
                        (str (fs/path repo-root "get-swarm-forge"))
                        "mini-forge")]
        (is (zero? (:exit result)) (:err result))
        (is (fs/exists? (fs/path project "swarmforge/scripts/handoffd.bb")))
        (is (= "MAIN-engineering\n" (slurp (str (fs/path project "swarmforge/constitution/articles/engineering.prompt")))))
        (is (= "PACK-PROJECT\n" (slurp (str (fs/path project "swarmforge/constitution/articles/project.prompt")))))
        (is (= "#!/bin/sh\necho pack-swarm\n" (slurp (str (fs/path project "swarm")))))
        (is (fs/exists? (fs/path project "swarmforge/roles/specifier.prompt"))))
      (finally
        (fs/delete-tree project)
        (fs/delete-tree base)
        (fs/delete-tree pack)))))

(deftest get-swarm-forge-writes-the-project-language-into-the-constitution
  ;; Given a pack whose project.prompt says the language is not set
  ;; When get-swarm-forge mini-forge typescript runs
  ;; Then that line names TypeScript; an unknown language fails; no language warns
  (let [base (tmp-dir)
        pack (tmp-dir)
        install (fn [project & args]
                  (apply run {:dir project :ok? false
                              :env {"SWARMFORGE_BASE_DIR" (str base)
                                    "SWARMFORGE_PACKS_DIR" (str pack)}}
                         (str (fs/path repo-root "get-swarm-forge")) "mini-forge" args))
        prompt-of (fn [project]
                    (slurp (str (fs/path project "swarmforge/constitution/articles/project.prompt"))))]
    (try
      (doseq [name ["swarmforge.sh" "handoffd.bb" "done_with_current.sh"]]
        (write-file (fs/path base "swarmforge/scripts" name) (str name "\n")))
      (doseq [article ["engineering" "workflow" "handoffs"]]
        (write-file (fs/path base "swarmforge/constitution/articles" (str article ".prompt")) "x\n"))
      (write-file (fs/path pack "swarm") "#!/bin/sh\n")
      (write-file (fs/path pack "swarmforge/swarmforge.conf") "window specifier claude master\n")
      (write-file (fs/path pack "swarmforge/constitution.prompt") "C\n")
      (write-file (fs/path pack "swarmforge/roles/specifier.prompt") "specifier\n")
      (write-file (fs/path pack "swarmforge/constitution/articles/project.prompt")
                  "# Project Rules\n- Project language: not set.\n- Keep state local.\n")
      (let [typed (tmp-dir) untyped (tmp-dir) bad (tmp-dir)]
        (try
          (is (zero? (:exit (install typed "typescript"))))
          (is (str/includes? (prompt-of typed) "- Project language: TypeScript.\n"))
          (is (str/includes? (prompt-of typed) "- Keep state local."))
          (let [result (install untyped)]
            (is (zero? (:exit result)))
            (is (str/includes? (:err result) "project language is not set"))
            (is (str/includes? (prompt-of untyped) "not set")))
          (let [result (install bad "cobol")]
            (is (= 1 (:exit result)))
            (is (str/includes? (:err result) "unknown language 'cobol'")))
          (finally
            (fs/delete-tree typed)
            (fs/delete-tree untyped)
            (fs/delete-tree bad))))
      (finally
        (fs/delete-tree base)
        (fs/delete-tree pack)))))

(deftest crap-script-fails-when-a-function-is-over-the-threshold
  ;; Given a fake lizard and a coverage report where classify is half covered (CRAP 8.1)
  ;; When crap.sh runs with thresholds either side of that
  ;; Then it exits 1 and names the function above the threshold, 0 below it
  (let [root (tmp-dir)
        bin (fs/path root "bin")]
    (try
      (write-file (fs/path bin "lizard")
                  (str "#!/bin/sh\n"
                       "printf '%s\\n' '13,5,60,1,14,\"classify@1-14@src/c.ts\",\"src/c.ts\",\"classify\",\"classify ( n )\",1,14'\n"))
      (fs/set-posix-file-permissions (fs/path bin "lizard") "rwxr-xr-x")
      (write-file (fs/path root "cov.lcov")
                  "SF:src/c.ts\nDA:2,2\nDA:3,1\nDA:6,0\nDA:7,0\nend_of_record\n")
      (let [crap (fn [threshold]
                   (run {:dir root :ok? false :env {"PATH" (str bin ":" (System/getenv "PATH"))}}
                        (script "crap.sh") "--lcov" "cov.lcov" "--threshold" threshold "src/c.ts"))
            strict (crap "5")
            lenient (crap "10")]
        (is (= 1 (:exit strict)))
        (is (str/includes? (:out strict) "classify"))
        (is (= 0 (:exit lenient)))
        (is (str/includes? (:out lenient) "0 over CRAP")))
      (finally
        (fs/delete-tree root)))))

(defn account-fixture
  "Two account dirs and a registry file. Returns the dirs and the env that points at the registry."
  [root]
  (let [personal (fs/create-dirs (fs/path root "accounts/personal-claude"))
        codex (fs/create-dirs (fs/path root "accounts/personal-codex"))
        work (fs/create-dirs (fs/path root "accounts/work-claude"))
        registry (fs/path root "accounts.conf")]
    (write-file registry (str "# name and one dir per backend\n"
                              "account personal claude=" personal " codex=" codex "\n"
                              "account work claude=" work "\n"))
    {:personal (str personal) :codex (str codex) :work (str work)
     :env {"SWARMFORGE_ACCOUNTS_FILE" (str registry)}}))

(deftest project-conf-selects-the-billing-account
  ;; Given a conf with `account personal` and a registry that defines it
  ;; When --test-parse
  ;; Then the project runs on the personal account
  (let [root (tmp-dir)
        {:keys [env]} (account-fixture root)]
    (try
      (write-pack-conf! root "account personal\nwindow coder claude master\n")
      (let [out (:out (run {:dir root :env env} (script "swarmforge.bb") "--test-parse" (str root)))]
        (is (str/includes? out "account personal")))
      (finally
        (fs/delete-tree root)))))

(deftest swarmforge-account-env-overrides-the-conf
  (let [root (tmp-dir)
        {:keys [env]} (account-fixture root)]
    (try
      (write-pack-conf! root "account personal\nwindow coder claude master\n")
      (let [out (:out (run {:dir root :env (assoc env "SWARMFORGE_ACCOUNT" "work")}
                           (script "swarmforge.bb") "--test-parse" (str root)))]
        (is (str/includes? out "account work"))
        (is (not (str/includes? out "account personal"))))
      (finally
        (fs/delete-tree root)))))

(deftest account-sets-each-backends-config-dir-for-the-agent
  ;; Given the personal account with claude and codex dirs
  ;; When the launch spec is built
  ;; Then claude gets CLAUDE_CONFIG_DIR and codex gets CODEX_HOME; no account sets neither
  (let [root (tmp-dir)
        {:keys [env personal codex]} (account-fixture root)
        spec (fn [agent extra-env]
               (:out (run {:dir root :env (merge env extra-env)}
                          (script "swarmforge.bb") "--test-launch-command" (str root) agent)))]
    (try
      (is (str/includes? (spec "claude" {"SWARMFORGE_ACCOUNT" "personal"})
                         (str "CLAUDE_CONFIG_DIR=" personal)))
      (is (str/includes? (spec "codex" {"SWARMFORGE_ACCOUNT" "personal"})
                         (str "CODEX_HOME=" codex)))
      (is (not (str/includes? (spec "claude" {}) "CLAUDE_CONFIG_DIR")))
      (finally
        (fs/delete-tree root)))))

(deftest account-problems-stop-the-launch-with-a-reason
  (let [root (tmp-dir)
        {:keys [env work]} (account-fixture root)
        parse (fn [conf extra-env]
                (write-pack-conf! root conf)
                (run {:dir root :ok? false :env (merge env extra-env)}
                     (script "swarmforge.bb") "--test-parse" (str root)))]
    (try
      (let [result (parse "account nobody\nwindow coder claude master\n" {})]
        (is (= 1 (:exit result)))
        (is (str/includes? (:err result) "Unknown account 'nobody'")))
      (let [result (parse "account work\nwindow coder codex master\n" {})]
        (is (= 1 (:exit result)))
        (is (str/includes? (:err result) "has no codex directory")))
      (fs/delete-tree work)
      (let [result (parse "account work\nwindow coder claude master\n" {})]
        (is (= 1 (:exit result)))
        (is (str/includes? (:err result) "does not exist")))
      (let [result (parse "account work\naccount work\nwindow coder claude master\n" {})]
        (is (= 1 (:exit result)))
        (is (str/includes? (:err result) "Duplicate account line")))
      (finally
        (fs/delete-tree root)))))

(deftest account-reaches-every-role-pane-through-herdr
  ;; Given a two-role project on the personal account
  ;; When the launcher opens the panes
  ;; Then the workspace and the extra tab are both created with CLAUDE_CONFIG_DIR
  (let [root (tmp-dir)
        {:keys [env personal]} (account-fixture root)]
    (try
      (write-pack-conf! root "account personal\nwindow coder claude master\nwindow cleaner claude cleaner\n")
      (write-file (fs/path root "swarmforge/roles/cleaner.prompt") "cleaner\n")
      (run {:dir root :env env} (script "swarmforge.bb") "--test-launch-roles" (str root))
      (let [calls (fake-herdr/calls root)
            opens (filter #(re-find #"^(workspace create|pane split)" %) calls)]
        (is (= 2 (count opens)))
        (is (every? #(str/includes? % (str "--env CLAUDE_CONFIG_DIR=" personal)) opens)))
      (finally
        (fs/delete-tree root)))))

(deftest codex-trust-is-written-into-the-account-home
  (let [root (tmp-dir)
        home (fs/create-temp-dir {:prefix "codex-account."})
        wt (str (fs/absolutize root))]
    (try
      (run {:dir root :env {"HOME" (str root)}} (script "swarmforge.bb")
           "--test-ensure-codex-trust" wt (str home))
      (is (str/includes? (slurp (str (fs/path home "config.toml")))
                         (str "[projects." (pr-str wt) "]")))
      (finally
        (fs/delete-tree root)
        (fs/delete-tree home)))))
