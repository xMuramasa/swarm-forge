(ns swarmforge.handoff-test
  (:require [babashka.fs :as fs]
            [clojure.java.shell :as sh]
            [clojure.string :as str]
            [clojure.test :refer [deftest is run-tests testing use-fixtures]]
            [swarmforge.fake-herdr :as fake-herdr]))

(def repo-root (fs/cwd))
(def scripts-dir (fs/path repo-root "swarmforge" "scripts"))
(def temp-dirs (atom []))

(use-fixtures :once
  (fn [tests]
    (try
      (tests)
      (finally
        (doseq [dir @temp-dirs]
          (fs/delete-tree dir))))))

(defn script [name]
  (str (fs/path scripts-dir name)))

(defn tmp-dir []
  (let [dir (fs/create-temp-dir {:prefix "swarmforge-handoff-test."})]
    (swap! temp-dirs conj dir)
    dir))

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

(defn write-file [path text]
  (fs/create-dirs (fs/parent path))
  (spit (str path) text))

(defn read-file [path]
  (slurp (str path)))

(defn init-repo! [root]
  (run {:dir root} "git" "init" "-q")
  (run {:dir root} "git" "config" "user.email" "test@example.com")
  (run {:dir root} "git" "config" "user.name" "Test User")
  (write-file (fs/path root "README.md") "initial\n")
  (run {:dir root} "git" "add" "README.md")
  (run {:dir root} "git" "commit" "-q" "-m" "Initial commit")
  (str/trim (:out (run {:dir root} "git" "rev-parse" "--short=10" "HEAD"))))

(defn role-spec-rows [roles]
  (if (map? roles)
    (mapv (fn [[role mode]] [role (or mode "task") ""]) roles)
    (mapv (fn [entry]
            (let [role (first entry)
                  mode (or (second entry) "task")
                  prop (or (nth entry 2 nil) "")]
              [role mode prop]))
          roles)))

(defn setup-project!
  ([root] (setup-project! root {"sender" "task" "receiver" "task"}))
  ([root roles]
   (doseq [dir [".swarmforge/handoffs/outbox/tmp"
                ".swarmforge/handoffs/sent"
                ".swarmforge/handoffs/failed"
                ".swarmforge/handoffs/inbox/new"
                ".swarmforge/handoffs/inbox/in_process"
                ".swarmforge/handoffs/inbox/completed"]]
     (fs/create-dirs (fs/path root dir)))
   (write-file
    (fs/path root ".swarmforge/roles.tsv")
    (apply str
           (for [[role mode prop] (role-spec-rows roles)]
             (format "%s\tmaster\t%s\tsession\t%s\tcodex\t%s\t%s\n"
                     role root (str/capitalize role) mode prop))))))

(defn handoff
  [{:keys [id from to recipient priority type task-id task commit body
           task-base-commit enqueued-at dequeued-at completed-at]}]
  (str "id: " id "\n"
       "from: " from "\n"
       "to: " to "\n"
       (when recipient (str "recipient: " recipient "\n"))
       "priority: " priority "\n"
       "type: " type "\n"
       (when task-id (str "task_id: " task-id "\n"))
       (when task (str "task: " task "\n"))
       (when commit (str "commit: " commit "\n"))
       (when task-base-commit (str "task_base_commit: " task-base-commit "\n"))
       (when enqueued-at (str "enqueued_at: " enqueued-at "\n"))
       (when dequeued-at (str "dequeued_at: " dequeued-at "\n"))
       (when completed-at (str "completed_at: " completed-at "\n"))
       "\n"
       (or body (str "payload for " id)) "\n"))

(defn handoff-path [root state filename]
  (fs/path root ".swarmforge" "handoffs" "inbox" state filename))

(defn put-handoff! [root state filename attrs]
  (let [path (handoff-path root state filename)]
    (write-file path (handoff attrs))
    path))

(defn header [path field]
  (some->> (str/split-lines (read-file path))
           (take-while seq)
           (some (fn [line]
                   (let [prefix (str field ": ")]
                     (when (str/starts-with? line prefix)
                       (subs line (count prefix))))))))

(defn head-sha [root]
  (str/trim (:out (run {:dir root} "git" "rev-parse" "--short=10" "HEAD"))))

(defn board-audit-count [root task-name]
  (let [file (fs/path root ".swarmforge/board/tasks.tsv")]
    (when (fs/regular-file? file)
      (some (fn [line]
              (let [[name _lane _created _updated _task-id audit-count]
                    (str/split line #"\t" -1)]
                (when (= task-name name)
                  (Long/parseLong (or (not-empty audit-count) "0")))))
            (str/split-lines (read-file file))))))

(defn audit-pending-dir [root]
  (fs/path root ".swarmforge/handoffs/audit_pending"))

(defn audit-sender-dirs [root]
  (let [dir (audit-pending-dir root)]
    (if (fs/directory? dir)
      (->> (fs/list-dir dir)
           (filter fs/directory?)
           vec)
      [])))

(defn empty-audit-sender-dirs [root]
  (->> (audit-sender-dirs root)
       (filter (fn [d]
                 (empty? (filter fs/regular-file? (fs/list-dir d)))))
       vec))

(defn audit-edn-files [root]
  (let [dir (audit-pending-dir root)]
    (if (fs/directory? dir)
      (vec (fs/glob dir "**/*.edn"))
      [])))

(defn queued-path [out]
  (some->> (str/split-lines out)
           (some (fn [line]
                   (when (str/starts-with? line "HANDOFF QUEUED: ")
                     (subs line (count "HANDOFF QUEUED: ")))))))

(defn outbox-handoffs [root]
  (let [dir (fs/path root ".swarmforge" "handoffs" "outbox")]
    (if (fs/directory? dir)
      (->> (fs/list-dir dir)
           (filter #(and (fs/regular-file? %) (str/ends-with? (fs/file-name %) ".handoff")))
           (sort-by #(fs/file-name %))
           vec)
      [])))

(defn outbox-to [root role]
  (some #(when (str/ends-with? (fs/file-name %) (str "_to_" role ".handoff")) %)
        (outbox-handoffs root)))

(defn handoff-body [path]
  (or (second (str/split (read-file path) #"\n\n" 2)) ""))

(defn audit-and-submit-git-handoff [opts draft]
  (let [first-call (run (assoc opts :ok? false)
                        (script "swarm_handoff.sh") (str draft))]
    (if (and (zero? (:exit first-call))
             (str/includes? (:out first-call) "AUDIT_REQUIRED"))
      (run opts (script "swarm_handoff.sh") (str draft))
      first-call)))

(defn make-queued-handoff!
  ([root filename attrs]
   (let [sha (or (:commit attrs) (head-sha root))]
     (put-handoff! root "new" filename
                   (merge {:from "sender"
                           :to "receiver"
                           :recipient "receiver"
                           :priority "50"
                           :type "git_handoff"
                           :task "task-one"
                           :commit sha
                           :body (str "merge_and_process sender " sha)}
                          attrs)))))

(deftest swarm-handoff-help-is-usage-not-a-draft
  ;; Given the handoff helper
  ;; When it is run with --help or -h
  ;; Then it prints usage and does not treat the flag as a missing draft file
  (doseq [flag ["--help" "-h"]]
    (let [result (run {:dir repo-root :ok? false}
                      (script "swarm_handoff.sh") flag)
          text (str (:err result) (:out result))]
      (is (zero? (:exit result)) flag)
      (is (str/includes? text "Usage:") flag)
      (is (not (str/includes? text "Draft file not found")) flag))))

(defn add-worktree! [root name]
  (let [wt (fs/path root ".worktrees" name)]
    (fs/create-dirs (fs/parent wt))
    (run {:dir root} "git" "worktree" "add" "-q" (str wt) "HEAD")
    wt))

(deftest swarm-handoff-queues-on-the-project-from-a-worktree
  ;; Given a sender worktree and a commit only made there
  ;; When swarm_handoff runs in that worktree
  ;; Then the queued file is on the project, and the commit is the worktree HEAD
  (let [root (tmp-dir)
        _ (init-repo! root)
        wt (add-worktree! root "sender")
        _ (setup-project! root {"sender" "task" "receiver" "task"})
        _ (write-file (fs/path root ".swarmforge" "roles.tsv")
                      (format "sender\tsender\t%s\tsession\tSender\tcodex\ttask\nreceiver\treceiver\t%s\tsession\tReceiver\tcodex\ttask\n"
                              wt root))
        _ (write-file (fs/path wt "slice.md") "from the worktree\n")
        _ (run {:dir wt} "git" "add" "slice.md")
        _ (run {:dir wt} "git" "commit" "-q" "-m" "Worktree slice")
        wt-head (str/trim (:out (run {:dir wt} "git" "rev-parse" "--short=10" "HEAD")))
        master-head (str/trim (:out (run {:dir root} "git" "rev-parse" "--short=10" "HEAD")))
        draft (fs/path wt "tmp" "from-wt.handoff")]
    (is (not= wt-head master-head))
    (write-file draft (format "type: git_handoff\nto: receiver\npriority: 50\ntask: task-from-worktree\ncommit: %s\n" wt-head))
    (let [result (audit-and-submit-git-handoff
                  {:dir wt :env {"SWARMFORGE_ROLE" "sender"}} draft)
          queued (queued-path (:out result))
          content (read-file queued)
          outbox (str (fs/canonicalize (fs/path root ".swarmforge" "handoffs" "outbox")))]
      (is (zero? (:exit result)))
      (is (str/starts-with? (str (fs/canonicalize queued)) outbox))
      (is (not (str/includes? queued "/.worktrees/")))
      (is (str/includes? content (str "commit: " wt-head "\n")))
      (is (not (str/includes? content (str "commit: " master-head "\n")))))))

(deftest swarm-handoff-infers-role-and-fills-worktree-head
  ;; Given a sender worktree and no SWARMFORGE_ROLE
  ;; When swarm_handoff runs there with a draft that names master's SHA or omits commit
  ;; Then it infers the role and queues the worktree HEAD
  (let [root (tmp-dir)
        _ (init-repo! root)
        wt (add-worktree! root "sender")
        _ (setup-project! root {"sender" "task" "receiver" "task"})
        _ (write-file (fs/path root ".swarmforge" "roles.tsv")
                      (format "sender\tsender\t%s\tsession\tSender\tcodex\ttask\nreceiver\treceiver\t%s\tsession\tReceiver\tcodex\ttask\n"
                              wt root))
        _ (write-file (fs/path wt "slice.md") "from the worktree\n")
        _ (run {:dir wt} "git" "add" "slice.md")
        _ (run {:dir wt} "git" "commit" "-q" "-m" "Worktree slice")
        wt-head (str/trim (:out (run {:dir wt} "git" "rev-parse" "--short=10" "HEAD")))
        master-head (str/trim (:out (run {:dir root} "git" "rev-parse" "--short=10" "HEAD")))]
    (is (not= wt-head master-head))
    (testing "infers role from worktree when env is missing"
      (let [draft (fs/path wt "tmp" "no-env.handoff")]
        (write-file draft (format "type: git_handoff\nto: receiver\npriority: 50\ntask: inferred-role\ncommit: %s\n" wt-head))
        (let [result (audit-and-submit-git-handoff {:dir wt :ok? false} draft)
              queued (queued-path (:out result))
              content (when (zero? (:exit result)) (read-file queued))]
          (is (zero? (:exit result)))
          (is (str/includes? (str content) "from: sender\n"))
          (is (str/includes? (str content) (str "commit: " wt-head "\n"))))))
    (testing "fills worktree HEAD even when the draft names master's SHA"
      (let [draft (fs/path wt "tmp" "wrong-sha.handoff")]
        (write-file draft (format "type: git_handoff\nto: receiver\npriority: 50\ntask: ignore-typed-sha\ncommit: %s\n" master-head))
        (let [result (audit-and-submit-git-handoff
                      {:dir wt :env {"SWARMFORGE_ROLE" "sender"} :ok? false} draft)
              queued (queued-path (:out result))
              content (when (zero? (:exit result)) (read-file queued))]
          (is (zero? (:exit result)))
          (is (str/includes? (str content) (str "commit: " wt-head "\n")))
          (is (not (str/includes? (str content) (str "commit: " master-head "\n")))))))
    (testing "fills HEAD when the draft omits commit"
      (let [draft (fs/path wt "tmp" "no-commit.handoff")]
        (write-file draft "type: git_handoff\nto: receiver\npriority: 50\ntask: omit-commit\n")
        (let [result (audit-and-submit-git-handoff
                      {:dir wt :env {"SWARMFORGE_ROLE" "sender"} :ok? false} draft)
              queued (queued-path (:out result))
              content (when (zero? (:exit result)) (read-file queued))]
          (is (zero? (:exit result)))
          (is (str/includes? (str content) (str "commit: " wt-head "\n"))))))))

(deftest swarm-handoff-rejects-drafts-outside-worktree-tmp
  ;; Given a git_handoff draft
  ;; When it lives in /tmp or the handoff outbox tmp
  ;; Then swarm_handoff refuses it and asks for ./tmp/ in the worktree
  (let [root (tmp-dir)
        commit (init-repo! root)]
    (setup-project! root)
    (testing "rejects a draft in /tmp"
      (let [draft (fs/path "/tmp" (str "swarmforge-bad-draft-" (System/currentTimeMillis) ".handoff"))]
        (try
          (write-file draft (format "type: git_handoff\nto: receiver\npriority: 50\ntask: scratch-tmp\ncommit: %s\n" commit))
          (let [result (run {:dir root :env {"SWARMFORGE_ROLE" "sender"} :ok? false}
                            (script "swarm_handoff.sh") (str draft))]
            (is (= 1 (:exit result)))
            (is (str/includes? (str (:err result) (:out result)) "./tmp/"))
            (is (fs/exists? draft)))
          (finally
            (fs/delete-if-exists draft)))))
    (testing "rejects a draft in the handoff outbox tmp"
      (let [draft (fs/path root ".swarmforge/handoffs/outbox/tmp/htw-console-app-coder.draft")]
        (write-file draft (format "type: git_handoff\nto: receiver\npriority: 50\ntask: outbox-scratch\ncommit: %s\n" commit))
        (let [result (run {:dir root :env {"SWARMFORGE_ROLE" "sender"} :ok? false}
                          (script "swarm_handoff.sh") (str draft))]
          (is (= 1 (:exit result)))
          (is (str/includes? (str (:err result) (:out result)) "./tmp/"))
          (is (fs/exists? draft)))))))

(deftest swarm-handoff-validates-and-queues-git-handoffs
  (let [root (tmp-dir)
        commit (init-repo! root)]
    (setup-project! root)
    (testing "git_handoff requires a task name"
      (let [draft (fs/path root "tmp" "missing-task.handoff")]
        (write-file draft (format "type: git_handoff\nto: receiver\npriority: 50\ncommit: %s\n" commit))
        (let [result (run {:dir root :env {"SWARMFORGE_ROLE" "sender"} :ok? false}
                          (script "swarm_handoff.sh") (str draft))]
          (is (= 2 (:exit result)))
          (is (str/includes? (:err result) "Missing required header 'task'"))
          (is (fs/exists? draft)))))
    (testing "valid git_handoff writes task, canonical commit, and generated payload"
      (let [draft (fs/path root "tmp" "valid.handoff")]
        (write-file draft (format "type: git_handoff\nto: receiver\npriority: 50\ntask: task-1-cave-setup\ncommit: %s\n" commit))
        (let [result (audit-and-submit-git-handoff
                      {:dir root :env {"SWARMFORGE_ROLE" "sender"}} draft)
              queued (queued-path (:out result))
              content (read-file queued)]
          (is (str/includes? content "task: task-1-cave-setup\n"))
          (is (str/includes? content (str "commit: " commit "\n")))
          (is (str/includes? content "artifacts: README.md\n"))
          (is (str/includes? content (str "merge_and_process.sh sender " commit)))
          (is (fs/exists? queued))
          (is (not (fs/exists? draft))))))))

(deftest swarm-handoff-uses-hidden-task-id
  ;; Given a sender has a current hidden task id
  ;; When a draft names a different task id
  ;; Then the handoff is rejected before it can become active stale work
  (let [root (tmp-dir)
        commit (init-repo! root)]
    (setup-project! root)
    (write-file (fs/path root ".swarmforge/board/tasks.tsv")
                "Visible Task\tsender\tcreated\tupdated\t20260825T120000000000Z-visible-task\n")
    (put-handoff! root "in_process" "50_current.handoff"
                  {:id "current"
                   :from "master"
                   :to "sender"
                   :recipient "sender"
                   :priority "50"
                   :type "note"
                   :task-id "20260825T120000000000Z-visible-task"
                   :task "Visible Task"})
    (let [draft (fs/path root "tmp" "stale.handoff")]
      (write-file draft (format "type: git_handoff\nto: receiver\npriority: 50\ntask_id: old-task-id\ntask: Visible Task\ncommit: %s\n" commit))
      (let [result (run {:dir root :env {"SWARMFORGE_ROLE" "sender"} :ok? false}
                        (script "swarm_handoff.sh") (str draft))]
        (is (= 2 (:exit result)))
        (is (str/includes? (:err result) "does not match current in-process task_id"))
        (is (empty? (fs/glob (fs/path root ".swarmforge/handoffs/outbox") "*.handoff")))))))

(deftest swarm-handoff-fills-task-id-from-in-process-name-only-draft
  (let [root (tmp-dir)
        commit (init-repo! root)
        hidden "20260826T162611432618Z-htw"]
    (setup-project! root)
    (write-file (fs/path root ".swarmforge/board/tasks.tsv")
                (str "HTW\tcoder\tcreated\tupdated\t" hidden "\n"
                     "extras\tsender\tcreated\tupdated\textras-id\n"))
    (put-handoff! root "in_process" "50_retry.handoff"
                  {:id "retry"
                   :from "(Retry)"
                   :to "sender"
                   :recipient "sender"
                   :priority "50"
                   :type "note"
                   :task-id hidden
                   :task "HTW"})
    (let [draft (fs/path root "tmp" "htw.handoff")]
      (write-file draft (format "type: git_handoff\nto: receiver\npriority: 50\ntask: HTW\ncommit: %s\n" commit))
      (let [result (audit-and-submit-git-handoff
                    {:dir root :env {"SWARMFORGE_ROLE" "sender"}} draft)
            queued (queued-path (:out result))
            content (when queued (read-file queued))]
        (is (zero? (:exit result)))
        (is (some? queued))
        (is (str/includes? (str content) (str "task_id: " hidden "\n")))
        (is (str/includes? (str content) "task: HTW\n"))
        (is (not (str/includes? (str (:err result) (:out result)) "does not match")))))))

(deftest swarm-handoff-help-does-not-require-draft-task-id
  (let [result (run {:dir repo-root :ok? false}
                    (script "swarm_handoff.sh") "--help")
        text (str (:err result) (:out result))]
    (is (zero? (:exit result)))
    (is (str/includes? text "task: <short-stable-task-name>"))
    (is (not (str/includes? text "task_id: <hidden-task-id>")))))

(deftest pack-board-project-root-from-worktree-matches-handoff-lib
  (let [root (tmp-dir)
        _ (init-repo! root)
        wt (add-worktree! root "coder")
        _ (setup-project! root {"coder" "task"})
        _ (write-file (fs/path root ".swarmforge" "roles.tsv")
                      (format "coder\tmaster\t%s\tsession\tCoder\tcodex\ttask\n" wt))]
    (run {:dir root} (script "pack_board.sh") "create" "--name" "HTW" "--lane" "coder" "--root" (str root))
    (let [from-lib (run {:dir wt} (script "handoff_lib.ts") "project-root")
          listed (run {:dir wt} (script "pack_board.sh") "list")]
      (is (= (str (fs/canonicalize root))
             (str (fs/canonicalize (str/trim (:out from-lib))))))
      (is (str/includes? (:out listed) "HTW")))))

(deftest ready-for-next-prints-note-task-name-and-body
  ;; Given a (New Task) note in the receiver inbox
  ;; When ready_for_next runs
  ;; Then it prints TASK_NAME and the card body
  (let [root (tmp-dir)]
    (init-repo! root)
    (setup-project! root {"receiver" "task"})
    (make-queued-handoff! root "50_20260615T000001Z_000001_from_New_Task_to_receiver.handoff"
                          {:id "20260615T000001Z_000001_from_New_Task"
                           :from "(New Task)"
                           :type "note"
                           :task "Holy Hand Grenade"
                           :body "The grenade is placed at setup.\n"})
    (let [result (run {:dir root :env {"SWARMFORGE_ROLE" "receiver"}}
                      (script "ready_for_next.sh"))
          out (:out result)]
      (is (zero? (:exit result)))
      (is (str/includes? out "FROM: (New Task)"))
      (is (str/includes? out "TYPE: note"))
      (is (str/includes? out "TASK_NAME: Holy Hand Grenade"))
      (is (str/includes? out "The grenade is placed at setup.")))))

(deftest ready-for-next-task-accepts-and-resumes-single-tasks
  (let [root (tmp-dir)]
    (init-repo! root)
    (setup-project! root {"receiver" "task"})
    (testing "accepts one queued task and prints task name"
      (make-queued-handoff! root "50_20260615T000001Z_000001_from_sender_to_receiver.handoff"
                            {:id "20260615T000001Z_000001_from_sender"
                             :task "task-alpha"})
      (let [result (run {:dir root :env {"SWARMFORGE_ROLE" "receiver"}}
                        (script "ready_for_next.sh"))
            out (:out result)
            in-process (fs/path root ".swarmforge/handoffs/inbox/in_process/50_20260615T000001Z_000001_from_sender_to_receiver.handoff")]
        (is (str/includes? out "TASK:"))
        (is (str/includes? out "TASK_NAME: task-alpha"))
        (is (fs/exists? in-process))
        (is (some? (header in-process "dequeued_at")))))
    (testing "returns existing in-process task before queued tasks"
      (make-queued-handoff! root "40_20260615T000002Z_000002_from_sender_to_receiver.handoff"
                            {:id "20260615T000002Z_000002_from_sender"
                             :priority "40"
                             :task "task-beta"})
      (let [result (run {:dir root :env {"SWARMFORGE_ROLE" "receiver"}}
                        (script "ready_for_next.sh"))]
        (is (str/includes? (:out result) "task-alpha"))
        (is (fs/exists? (fs/path root ".swarmforge/handoffs/inbox/new/40_20260615T000002Z_000002_from_sender_to_receiver.handoff")))))))

(deftest ready-for-next-waits-while-outbound-approval-is-active
  ;; Given sender has an outbound git_handoff pending approval
  ;; When sender asks for another task
  ;; Then no new task is dequeued from the inbox
  (let [root (tmp-dir)]
    (init-repo! root)
    (setup-project! root)
    (write-file (fs/path root ".swarmforge/roles.tsv")
                (format "sender\tmaster\t%s\tsession\tSender\tcodex\ttask\nreceiver\treceiver\t%s\tsession\tReceiver\tcodex\ttask\n"
                        root (fs/path root ".worktrees/receiver")))
    (write-file (fs/path root ".swarmforge/handoffs/pending_approval/50_pending.handoff")
                "from: sender\nto: receiver\npriority: 50\ntype: git_handoff\ntask_id: task-one\ntask: task-one\ncommit: 1234567890\n\npayload\n")
    (put-handoff! root "new" "50_next.handoff"
                  {:id "next"
                   :from "(New Task)"
                   :to "sender"
                   :recipient "sender"
                   :priority "50"
                   :type "note"
                   :task-id "task-two"
                   :task "task-two"
                   :body "next task"})
    (let [result (run {:dir root :env {"SWARMFORGE_ROLE" "sender"} :ok? false}
                      (script "ready_for_next.sh"))]
      (is (= 2 (:exit result)))
      (is (str/includes? (:err result) "WAITING_FOR_APPROVAL"))
      (is (fs/exists? (fs/path root ".swarmforge/handoffs/inbox/new/50_next.handoff")))
      (is (empty? (fs/glob (fs/path root ".swarmforge/handoffs/inbox/in_process") "*.handoff"))))))

(deftest ready-for-next-waits-while-outbound-handoff-is-in-outbox
  ;; Given sender has queued a git_handoff that handoffd has not processed yet
  ;; When sender asks for another task
  ;; Then sender is still treated as busy
  (let [root (tmp-dir)]
    (init-repo! root)
    (setup-project! root)
    (write-file (fs/path root ".swarmforge/roles.tsv")
                (format "sender\tmaster\t%s\tsession\tSender\tcodex\ttask\nreceiver\treceiver\t%s\tsession\tReceiver\tcodex\ttask\n"
                        root (fs/path root ".worktrees/receiver")))
    (write-file (fs/path root ".swarmforge/handoffs/outbox/50_outbound.handoff")
                "from: sender\nto: receiver\npriority: 50\ntype: git_handoff\ntask_id: task-one\ntask: task-one\ncommit: 1234567890\n\npayload\n")
    (put-handoff! root "new" "50_next.handoff"
                  {:id "next"
                   :from "(New Task)"
                   :to "sender"
                   :recipient "sender"
                   :priority "50"
                   :type "note"
                   :task-id "task-two"
                   :task "task-two"
                   :body "next task"})
    (let [result (run {:dir root :env {"SWARMFORGE_ROLE" "sender"} :ok? false}
                      (script "ready_for_next.sh"))]
      (is (= 2 (:exit result)))
      (is (str/includes? (:err result) "WAITING_FOR_APPROVAL"))
      (is (fs/exists? (fs/path root ".swarmforge/handoffs/inbox/new/50_next.handoff")))
      (is (empty? (fs/glob (fs/path root ".swarmforge/handoffs/inbox/in_process") "*.handoff"))))))

(deftest ready-for-next-starts-next-task-after-outbound-approval-delivered
  ;; Given sender's prior git_handoff is already approved and in receiver's process
  ;; When sender asks for another task
  ;; Then the next queued task starts
  (let [root (tmp-dir)
        receiver (fs/path root ".worktrees/receiver")]
    (init-repo! root)
    (fs/create-dirs receiver)
    (setup-project! root)
    (write-file (fs/path root ".swarmforge/roles.tsv")
                (format "sender\tmaster\t%s\tsession\tSender\tcodex\ttask\nreceiver\treceiver\t%s\tsession\tReceiver\tcodex\ttask\n"
                        root receiver))
    (write-file (fs/path receiver ".swarmforge/handoffs/inbox/in_process/50_prior.handoff")
                "from: sender\nto: receiver\nrecipient: receiver\npriority: 50\ntype: git_handoff\ntask_id: task-one\ntask: task-one\ncommit: 1234567890\napproved: true\n\npayload\n")
    (put-handoff! root "new" "50_next.handoff"
                  {:id "next"
                   :from "(New Task)"
                   :to "sender"
                   :recipient "sender"
                   :priority "50"
                   :type "note"
                   :task-id "task-two"
                   :task "task-two"
                   :body "next task"})
    (let [result (run {:dir root :env {"SWARMFORGE_ROLE" "sender"}}
                      (script "ready_for_next.sh"))
          in-process (fs/path root ".swarmforge/handoffs/inbox/in_process/50_next.handoff")]
      (is (zero? (:exit result)))
      (is (str/includes? (:out result) "TASK_NAME: task-two"))
      (is (fs/exists? in-process))
      (is (not (fs/exists? (fs/path root ".swarmforge/handoffs/inbox/new/50_next.handoff")))))))

(deftest handoffd-wakes-sender-after-approved-handoff-unblocks-queued-work
  ;; Given an approved sender handoff is ready to deliver and sender has queued mail
  ;; When handoffd delivers the approved handoff to the receiver
  ;; Then the receiver and the now-unblocked sender are notified
  (let [root (tmp-dir)
        receiver (fs/path root ".worktrees/receiver")]
    (init-repo! root)
    (setup-project! root)
    (fake-herdr/add-agents! root ["sender-session" "receiver-session"])
    (write-file (fs/path root ".swarmforge/roles.tsv")
                (format "sender\tmaster\t%s\tsender-session\tSender\tcodex\ttask\nreceiver\treceiver\t%s\treceiver-session\tReceiver\tcodex\ttask\n"
                        root receiver))
    (write-file (fs/path root ".swarmforge/handoffs/outbox/50_approved.handoff")
                "from: sender\nto: receiver\npriority: 50\ntype: git_handoff\ntask_id: task-one\ntask: task-one\ncommit: 1234567890\napproved: true\n\npayload\n")
    (put-handoff! root "new" "50_next.handoff"
                  {:id "next"
                   :from "(New Task)"
                   :to "sender"
                   :recipient "sender"
                   :priority "50"
                   :type "note"
                   :task-id "task-two"
                   :task "task-two"
                   :body "next task"})
    (let [result (run {:dir root}
                      (script "handoffd.ts") "--once" (str root))
          woken (set (map first (fake-herdr/prompts root)))]
      (is (zero? (:exit result)))
      (is (fs/exists? (fs/path receiver ".swarmforge/handoffs/inbox/new/50_approved.handoff")))
      (is (fs/exists? (fs/path root ".swarmforge/handoffs/inbox/new/50_next.handoff")))
      (is (contains? woken "receiver-session"))
      (is (contains? woken "sender-session"))
      (is (str/includes? (read-file (fs/path root ".swarmforge/daemon/handoffd.log"))
                         "notified-unblocked-sender sender")))))

(deftest ready-for-next-batch-waits-while-outbound-approval-is-active
  ;; Given a batch-mode sender has an outbound git_handoff pending approval
  ;; When sender asks for the next batch
  ;; Then no batch is created from queued inbox work
  (let [root (tmp-dir)]
    (init-repo! root)
    (setup-project! root {"sender" "batch" "receiver" "task"})
    (write-file (fs/path root ".swarmforge/roles.tsv")
                (format "sender\tmaster\t%s\tsession\tSender\tcodex\tbatch\nreceiver\treceiver\t%s\tsession\tReceiver\tcodex\ttask\n"
                        root (fs/path root ".worktrees/receiver")))
    (write-file (fs/path root ".swarmforge/handoffs/pending_approval/50_pending.handoff")
                "from: sender\nto: receiver\npriority: 50\ntype: git_handoff\ntask_id: task-one\ntask: task-one\ncommit: 1234567890\n\npayload\n")
    (put-handoff! root "new" "50_next.handoff"
                  {:id "next"
                   :from "(New Task)"
                   :to "sender"
                   :recipient "sender"
                   :priority "50"
                   :type "note"
                   :task-id "task-two"
                   :task "task-two"
                   :body "next task"})
    (let [result (run {:dir root :env {"SWARMFORGE_ROLE" "sender"} :ok? false}
                      (script "ready_for_next.sh"))]
      (is (= 2 (:exit result)))
      (is (str/includes? (:err result) "WAITING_FOR_APPROVAL"))
      (is (fs/exists? (fs/path root ".swarmforge/handoffs/inbox/new/50_next.handoff")))
      (is (empty? (fs/glob (fs/path root ".swarmforge/handoffs/inbox/in_process") "batch_*"))))))

(deftest ready-for-next-batch-groups-equal-priority-handoffs
  (let [root (tmp-dir)]
    (init-repo! root)
    (setup-project! root {"receiver" "batch"})
    (make-queued-handoff! root "10_20260615T000001Z_000001_from_sender_to_receiver.handoff"
                          {:id "20260615T000001Z_000001_from_sender" :priority "10" :task "task-a"})
    (make-queued-handoff! root "10_20260615T000002Z_000002_from_sender_to_receiver.handoff"
                          {:id "20260615T000002Z_000002_from_sender" :priority "10" :task "task-b"})
    (make-queued-handoff! root "20_20260615T000003Z_000003_from_sender_to_receiver.handoff"
                          {:id "20260615T000003Z_000003_from_sender" :priority "20" :task "task-c"})
    (let [result (run {:dir root :env {"SWARMFORGE_ROLE" "receiver"}}
                      (script "ready_for_next.sh"))
          out (:out result)
          batch-dir (->> (str/split-lines out)
                         (filter #(str/starts-with? % "BATCH: "))
                         first
                         (#(subs % 7)))]
      (is (str/includes? out "COUNT: 2"))
      (is (str/includes? out "TASK_NAME: task-a"))
      (is (str/includes? out "TASK_NAME: task-b"))
      (is (not (str/includes? out "TASK_NAME: task-c")))
      (let [lines (str/split-lines out)
            batch-i (first (keep-indexed (fn [i line] (when (str/starts-with? line "BATCH:") i)) lines))
            name-i (first (keep-indexed (fn [i line] (when (str/starts-with? line "TASK_NAME:") i)) lines))
            item-i (first (keep-indexed (fn [i line] (when (str/starts-with? line "BATCH_ITEM:") i)) lines))]
        (is (< batch-i name-i item-i))
        (is (= "TASK_NAME: task-a" (nth lines name-i))))
      (is (= 2 (count (fs/glob batch-dir "*.handoff"))))
      (is (fs/exists? (fs/path root ".swarmforge/handoffs/inbox/new/20_20260615T000003Z_000003_from_sender_to_receiver.handoff"))))))

(deftest done-with-current-replaces-an-existing-completed-file
  (let [root (tmp-dir)
        name "50_retry_htw.handoff"]
    (init-repo! root)
    (setup-project! root {"receiver" "task"})
    (put-handoff! root "in_process" name
                  {:id "retry"
                   :from "(Retry)" :to "receiver" :recipient "receiver"
                   :priority "50" :type "note" :task "htw"})
    (put-handoff! root "completed" name
                  {:id "retry-old"
                   :from "(Retry)" :to "receiver" :recipient "receiver"
                   :priority "50" :type "note" :task "htw"
                   :completed-at "2026-08-26T22:45:36.178441Z"})
    (let [result (run {:dir root :env {"SWARMFORGE_ROLE" "receiver"}}
                      (script "done_with_current.sh"))
          completed (fs/path root ".swarmforge/handoffs/inbox/completed" name)
          in-process (fs/path root ".swarmforge/handoffs/inbox/in_process" name)]
      (is (zero? (:exit result)))
      (is (str/includes? (:out result) "COMPLETED:"))
      (is (not (fs/exists? in-process)))
      (is (fs/exists? completed))
      (is (not= "2026-08-26T22:45:36.178441Z" (header completed "completed_at"))))))

(deftest done-with-current-task-completes-without-accepting-next
  ;; Given a current task and more mail in the inbox
  ;; When done_with_current runs
  ;; Then it completes the current task, leaves the next item queued, and prints MAIL_WAITING
  (let [root (tmp-dir)]
    (init-repo! root)
    (setup-project! root {"receiver" "task"})
    (put-handoff! root "in_process" "50_20260615T000001Z_000001_from_sender_to_receiver.handoff"
                  {:id "20260615T000001Z_000001_from_sender"
                   :from "sender" :to "receiver" :recipient "receiver"
                   :priority "50" :type "git_handoff" :task "task-current"
                   :commit (head-sha root)})
    (make-queued-handoff! root "50_20260615T000002Z_000002_from_sender_to_receiver.handoff"
                          {:id "20260615T000002Z_000002_from_sender"
                           :task "task-next"})
    (let [result (run {:dir root :env {"SWARMFORGE_ROLE" "receiver"}}
                      (script "done_with_current.sh"))
          completed (fs/path root ".swarmforge/handoffs/inbox/completed/50_20260615T000001Z_000001_from_sender_to_receiver.handoff")
          next-file (fs/path root ".swarmforge/handoffs/inbox/new/50_20260615T000002Z_000002_from_sender_to_receiver.handoff")]
      (is (str/includes? (:out result) "COMPLETED:"))
      (is (str/includes? (:out result) "MAIL_WAITING"))
      (is (not (str/includes? (:out result) "TASK_NAME: task-next")))
      (is (some? (header completed "completed_at")))
      (is (fs/exists? next-file))
      (is (nil? (header next-file "dequeued_at"))))))

(deftest swarm-handoff-auto-completes-current-after-git-handoff
  ;; Given a sender has current work and another item waiting
  ;; When swarm_handoff requests an audit and is then resubmitted unchanged
  ;; Then the first call retains current work and the second queues and completes it
  (let [root (tmp-dir)
        base (init-repo! root)
        current-file "50_20260615T000001Z_000001_from_planner_to_sender.handoff"
        next-file "50_20260615T000002Z_000002_from_planner_to_sender.handoff"
        completed (fs/path root ".swarmforge/handoffs/inbox/completed" current-file)
        queued-next (fs/path root ".swarmforge/handoffs/inbox/new" next-file)
        draft (fs/path root "tmp" "jump.handoff")]
    (setup-project! root {"sender" "task" "receiver" "task"})
    (write-file (fs/path root ".swarmforge/board/tasks.tsv")
                (str "jump\tsender\tcreated\tupdated\tjump-id\n"
                     "extras\tsender\tcreated\tupdated\textras-id\n"))
    (is (= 0 (board-audit-count root "jump")))
    (is (= 0 (board-audit-count root "extras")))
    (put-handoff! root "in_process" current-file
                  {:id "20260615T000001Z_000001_from_planner"
                   :from "planner" :to "sender" :recipient "sender"
                   :priority "50" :type "note"
                   :task-id "jump-id" :task "jump"
                   :task-base-commit base
                   :body "jump"})
    (put-handoff! root "new" next-file
                  {:id "20260615T000002Z_000002_from_planner"
                   :from "planner" :to "sender" :recipient "sender"
                   :priority "50" :type "note"
                   :task-id "extras-id" :task "extras"
                   :body "extras"})
    (write-file (fs/path root "jump.md") "jump\n")
    (run {:dir root} "git" "add" "jump.md")
    (run {:dir root} "git" "commit" "-q" "-m" "Jump")
    (write-file draft "type: git_handoff\nto: receiver\npriority: 50\ntask: jump\n")
    (let [first-call (run {:dir root :env {"SWARMFORGE_ROLE" "sender"}}
                          (script "swarm_handoff.sh") (str draft))
          audit-files (fs/glob (fs/path root ".swarmforge/handoffs/audit_pending") "**/*.edn")]
      (is (zero? (:exit first-call)))
      (is (str/includes? (:out first-call) "AUDIT_REQUIRED"))
      (is (empty? (fs/glob (fs/path root ".swarmforge/handoffs/outbox") "*.handoff")))
      (is (= 1 (count audit-files)))
      (is (= 1 (board-audit-count root "jump")))
      (is (= 0 (board-audit-count root "extras")))
      (is (fs/exists? (handoff-path root "in_process" current-file)))
      (is (not (fs/exists? completed)))
      (is (fs/exists? draft)))
    (let [result (run {:dir root :env {"SWARMFORGE_ROLE" "sender"}}
                      (script "swarm_handoff.sh") (str draft))
          queued (queued-path (:out result))
          content (read-file queued)]
      (is (zero? (:exit result)))
      (is (str/includes? (:out result) "HANDOFF QUEUED:"))
      (is (str/includes? (:out result) "COMPLETED:"))
      (is (str/includes? (:out result) "MAIL_WAITING"))
      (is (str/includes? content "task_id: jump-id\n"))
      (is (= 1 (board-audit-count root "jump")))
      (is (empty? (audit-edn-files root)))
      (is (empty? (empty-audit-sender-dirs root)))
      (is (some? (header completed "completed_at")))
      (is (fs/exists? queued-next))
      (is (nil? (header queued-next "dequeued_at"))))))

(deftest swarm-handoff-requires-a-new-audit-after-the-commit-changes
  (let [root (tmp-dir)
        _ (init-repo! root)
        _ (setup-project! root)
        _ (write-file (fs/path root ".swarmforge/board/tasks.tsv")
                      "changed-commit\tsender\tcreated\tupdated\tchanged-commit-id\t0\n")
        draft (fs/path root "tmp" "changed-commit.handoff")
        opts {:dir root :env {"SWARMFORGE_ROLE" "sender"}}]
    (write-file draft "type: git_handoff\nto: receiver\npriority: 50\ntask: changed-commit\n")
    (let [first-call (run opts (script "swarm_handoff.sh") (str draft))]
      (is (str/includes? (:out first-call) "AUDIT_REQUIRED"))
      (is (= 1 (board-audit-count root "changed-commit"))))
    (write-file (fs/path root "changed.md") "changed\n")
    (run {:dir root} "git" "add" "changed.md")
    (run {:dir root} "git" "commit" "-q" "-m" "Change after audit")
    (let [changed-call (run opts (script "swarm_handoff.sh") (str draft))]
      (is (str/includes? (:out changed-call) "AUDIT_REQUIRED"))
      (is (= 2 (board-audit-count root "changed-commit")))
      (is (empty? (fs/glob (fs/path root ".swarmforge/handoffs/outbox") "*.handoff"))))
    (let [submitted (run opts (script "swarm_handoff.sh") (str draft))
          queued (queued-path (:out submitted))]
      (is (some? queued))
      (is (= 2 (board-audit-count root "changed-commit")))
      (is (str/includes? (read-file queued) (str "commit: " (head-sha root) "\n"))))))

(deftest swarm-handoff-invalidates-an-audit-before-rejecting-a-changed-commit
  (let [root (tmp-dir)
        _ (init-repo! root)
        _ (setup-project! root)
        draft (fs/path root "tmp" "invalid-commit-change.handoff")
        opts {:dir root :env {"SWARMFORGE_ROLE" "sender"}}]
    (write-file draft "type: git_handoff\nto: receiver\npriority: 50\ntask: invalid-commit-change\n")
    (is (str/includes? (:out (run opts (script "swarm_handoff.sh") (str draft)))
                       "AUDIT_REQUIRED"))
    (run {:dir root} "git" "commit" "-q" "--allow-empty" "-m" "Empty change")
    (let [invalid-change (run (assoc opts :ok? false)
                              (script "swarm_handoff.sh") (str draft))]
      (is (= 1 (:exit invalid-change)))
      (is (str/includes? (:err invalid-change) "has no changed files")))
    (run {:dir root} "git" "reset" "--hard" "HEAD^")
    (let [after-restore (run opts (script "swarm_handoff.sh") (str draft))]
      (is (str/includes? (:out after-restore) "AUDIT_REQUIRED"))
      (is (nil? (queued-path (:out after-restore)))))
    (is (some? (queued-path (:out (run opts (script "swarm_handoff.sh") (str draft))))))))

(deftest swarm-handoff-requires-a-new-audit-after-the-draft-changes
  (let [root (tmp-dir)
        _ (init-repo! root)
        _ (setup-project! root)
        draft (fs/path root "tmp" "changed-draft.handoff")
        opts {:dir root :env {"SWARMFORGE_ROLE" "sender"}}]
    (write-file draft "type: git_handoff\nto: receiver\npriority: 50\ntask: changed-draft\n")
    (let [first-call (run opts (script "swarm_handoff.sh") (str draft))]
      (is (str/includes? (:out first-call) "AUDIT_REQUIRED")))
    (write-file draft "type: git_handoff\nto: receiver\npriority: 40\ntask: changed-draft\n")
    (let [changed-call (run opts (script "swarm_handoff.sh") (str draft))]
      (is (str/includes? (:out changed-call) "AUDIT_REQUIRED"))
      (is (empty? (fs/glob (fs/path root ".swarmforge/handoffs/outbox") "*.handoff"))))
    (let [submitted (run opts (script "swarm_handoff.sh") (str draft))
          queued (queued-path (:out submitted))]
      (is (some? queued))
      (is (str/includes? (read-file queued) "priority: 40\n")))))

(deftest swarm-handoff-invalidates-an-older-task-audit-for-the-same-sender
  (let [root (tmp-dir)
        _ (init-repo! root)
        _ (setup-project! root)
        draft (fs/path root "tmp" "switch-task.handoff")
        opts {:dir root :env {"SWARMFORGE_ROLE" "sender"}}]
    (write-file draft "type: git_handoff\nto: receiver\npriority: 50\ntask_id: first-id\ntask: first\n")
    (is (str/includes? (:out (run opts (script "swarm_handoff.sh") (str draft)))
                       "AUDIT_REQUIRED"))
    (write-file draft "type: git_handoff\nto: receiver\npriority: 50\ntask_id: second-id\ntask: second\n")
    (is (str/includes? (:out (run opts (script "swarm_handoff.sh") (str draft)))
                       "AUDIT_REQUIRED"))
    (is (= 1 (count (fs/glob (fs/path root ".swarmforge/handoffs/audit_pending") "**/*.edn"))))
    (write-file draft "type: git_handoff\nto: receiver\npriority: 50\ntask_id: first-id\ntask: first\n")
    (let [return-to-first (run opts (script "swarm_handoff.sh") (str draft))]
      (is (str/includes? (:out return-to-first) "AUDIT_REQUIRED"))
      (is (nil? (queued-path (:out return-to-first)))))
    (is (some? (queued-path (:out (run opts (script "swarm_handoff.sh") (str draft))))))))

(deftest swarm-handoff-invalidates-an-audit-when-the-changed-draft-is-invalid
  (let [root (tmp-dir)
        _ (init-repo! root)
        _ (setup-project! root)
        draft (fs/path root "tmp" "invalid-change.handoff")
        valid "type: git_handoff\nto: receiver\npriority: 50\ntask_id: task-id\ntask: task\n"
        opts {:dir root :env {"SWARMFORGE_ROLE" "sender"}}]
    (write-file draft valid)
    (is (str/includes? (:out (run opts (script "swarm_handoff.sh") (str draft)))
                       "AUDIT_REQUIRED"))
    (write-file draft (str valid "unknown: value\n"))
    (is (= 2 (:exit (run (assoc opts :ok? false)
                         (script "swarm_handoff.sh") (str draft)))))
    (is (empty? (audit-edn-files root)))
    (is (empty? (empty-audit-sender-dirs root)))
    (write-file draft valid)
    (let [after-repair (run opts (script "swarm_handoff.sh") (str draft))]
      (is (str/includes? (:out after-repair) "AUDIT_REQUIRED"))
      (is (nil? (queued-path (:out after-repair)))))
    (is (some? (queued-path (:out (run opts (script "swarm_handoff.sh") (str draft))))))))

(deftest swarm-handoff-keeps-audits-isolated-by-sender
  (let [root (tmp-dir)
        _ (init-repo! root)
        _ (setup-project! root)
        sender-draft (fs/path root "tmp" "sender.handoff")
        receiver-draft (fs/path root "tmp" "receiver.handoff")
        sender-opts {:dir root :env {"SWARMFORGE_ROLE" "sender"}}
        receiver-opts {:dir root :env {"SWARMFORGE_ROLE" "receiver"}}]
    (write-file sender-draft "type: git_handoff\nto: receiver\npriority: 50\ntask_id: first-id\ntask: first\n")
    (write-file receiver-draft "type: git_handoff\nto: sender\npriority: 50\ntask_id: second-id\ntask: second\n")
    (run sender-opts (script "swarm_handoff.sh") (str sender-draft))
    (run receiver-opts (script "swarm_handoff.sh") (str receiver-draft))
    (is (= 2 (count (audit-edn-files root))))
    (is (some? (queued-path (:out (run sender-opts (script "swarm_handoff.sh")
                                       (str sender-draft))))))
    (is (= 1 (count (audit-edn-files root))))
    (is (empty? (empty-audit-sender-dirs root)))
    (is (some? (queued-path (:out (run receiver-opts (script "swarm_handoff.sh")
                                       (str receiver-draft))))))
    (is (empty? (audit-edn-files root)))
    (is (empty? (empty-audit-sender-dirs root)))))

(deftest swarm-handoff-removes-empty-audit-pending-sender-directories
  (let [root (tmp-dir)
        _ (init-repo! root)
        _ (setup-project! root)
        draft (fs/path root "tmp" "empty-dirs.handoff")
        opts {:dir root :env {"SWARMFORGE_ROLE" "sender"}}
        lock (fs/path (audit-pending-dir root) ".lock")]
    (write-file draft "type: git_handoff\nto: receiver\npriority: 50\ntask: empty-dirs\n")
    (is (str/includes? (:out (run opts (script "swarm_handoff.sh") (str draft)))
                       "AUDIT_REQUIRED"))
    (is (= 1 (count (audit-edn-files root))))
    (is (= 1 (count (audit-sender-dirs root))))
    (is (empty? (empty-audit-sender-dirs root)))
    (is (fs/exists? lock))
    (is (some? (queued-path (:out (run opts (script "swarm_handoff.sh") (str draft))))))
    (is (empty? (audit-edn-files root)))
    (is (empty? (audit-sender-dirs root)))
    (is (empty? (empty-audit-sender-dirs root)))
    (is (fs/directory? (audit-pending-dir root)))
    (is (fs/exists? lock))
    (doseq [path (fs/glob (fs/path root ".swarmforge/handoffs/outbox") "*.handoff")]
      (fs/delete-if-exists path))
    (write-file (fs/path root "next.md") "next\n")
    (run {:dir root} "git" "add" "next.md")
    (run {:dir root} "git" "commit" "-q" "-m" "Next slice")
    (write-file draft "type: git_handoff\nto: receiver\npriority: 50\ntask: empty-dirs-next\n")
    (is (str/includes? (:out (run opts (script "swarm_handoff.sh") (str draft)))
                       "AUDIT_REQUIRED"))
    (is (= 1 (count (audit-edn-files root))))
    (is (= 1 (count (audit-sender-dirs root))))
    (is (empty? (empty-audit-sender-dirs root)))
    (write-file (fs/path root "changed.md") "changed\n")
    (run {:dir root} "git" "add" "changed.md")
    (run {:dir root} "git" "commit" "-q" "-m" "Change after audit")
    (is (str/includes? (:out (run opts (script "swarm_handoff.sh") (str draft)))
                       "AUDIT_REQUIRED"))
    (is (= 1 (count (audit-edn-files root))))
    (is (empty? (empty-audit-sender-dirs root)))
    (is (some? (queued-path (:out (run opts (script "swarm_handoff.sh") (str draft))))))
    (is (empty? (audit-edn-files root)))
    (is (empty? (audit-sender-dirs root)))
    (is (empty? (empty-audit-sender-dirs root)))
    (is (fs/directory? (audit-pending-dir root)))
    (is (fs/exists? lock))))

(deftest swarm-handoff-refuses-ambiguous-current-before-queueing
  ;; Given a sender has ambiguous current work
  ;; When swarm_handoff is asked to queue a git_handoff
  ;; Then it refuses before writing an outbox file
  (let [root (tmp-dir)
        _ (init-repo! root)
        draft (fs/path root "tmp" "ambiguous.handoff")]
    (setup-project! root {"sender" "task" "receiver" "task"})
    (doseq [filename ["40_20260615T000001Z_000001_from_planner_to_sender.handoff"
                      "50_20260615T000002Z_000002_from_planner_to_sender.handoff"]]
      (put-handoff! root "in_process" filename
                    {:id filename
                     :from "planner" :to "sender" :recipient "sender"
                     :priority "50" :type "note"
                     :task-id "jump-id" :task "jump"
                     :body "jump"}))
    (write-file (fs/path root "jump.md") "jump\n")
    (run {:dir root} "git" "add" "jump.md")
    (run {:dir root} "git" "commit" "-q" "-m" "Jump")
    (write-file draft "type: git_handoff\nto: receiver\npriority: 50\ntask: jump-id\n")
    (let [result (run {:dir root :env {"SWARMFORGE_ROLE" "sender"} :ok? false}
                      (script "swarm_handoff.sh") (str draft))
          outbox-files (fs/glob (fs/path root ".swarmforge/handoffs/outbox") "*.handoff")]
      (is (= 2 (:exit result)))
      (is (str/includes? (:err result) "Ambiguous current work: multiple tasks are in process."))
      (is (empty? outbox-files))
      (is (fs/exists? draft)))))

(deftest done-with-current-batch-completes-without-accepting-next
  ;; Given a current batch and more mail in the inbox
  ;; When done_with_current runs
  ;; Then it completes the batch, leaves the next item queued, and prints MAIL_WAITING
  (let [root (tmp-dir)
        batch (fs/path root ".swarmforge/handoffs/inbox/in_process/batch_20260615T000001Z_000001")]
    (init-repo! root)
    (setup-project! root {"receiver" "batch"})
    (fs/create-dirs batch)
    (write-file (fs/path batch "10_20260615T000001Z_000001_from_sender_to_receiver.handoff")
                (handoff {:id "20260615T000001Z_000001_from_sender"
                          :from "sender" :to "receiver" :recipient "receiver"
                          :priority "10" :type "git_handoff" :task "task-a"
                          :commit (head-sha root)}))
    (write-file (fs/path batch "10_20260615T000002Z_000002_from_sender_to_receiver.handoff")
                (handoff {:id "20260615T000002Z_000002_from_sender"
                          :from "sender" :to "receiver" :recipient "receiver"
                          :priority "10" :type "git_handoff" :task "task-b"
                          :commit (head-sha root)}))
    (make-queued-handoff! root "20_20260615T000003Z_000003_from_sender_to_receiver.handoff"
                          {:id "20260615T000003Z_000003_from_sender"
                           :priority "20"
                           :task "task-c"})
    (let [result (run {:dir root :env {"SWARMFORGE_ROLE" "receiver"}}
                      (script "done_with_current.sh"))
          completed-batch (fs/path root ".swarmforge/handoffs/inbox/completed/batch_20260615T000001Z_000001")
          next-file (fs/path root ".swarmforge/handoffs/inbox/new/20_20260615T000003Z_000003_from_sender_to_receiver.handoff")]
      (is (str/includes? (:out result) "COMPLETED_BATCH:"))
      (is (str/includes? (:out result) "MAIL_WAITING"))
      (is (not (str/includes? (:out result) "TASK_NAME: task-c")))
      (is (= 2 (count (fs/glob completed-batch "*.handoff"))))
      (is (every? #(some? (header % "completed_at"))
                  (fs/glob completed-batch "*.handoff")))
      (is (fs/exists? next-file)))))

(deftest stop-handoff-daemon-stops-running-process-and-removes-pid-file
  (let [root (tmp-dir)]
    (init-repo! root)
    (fs/create-dirs (fs/path root ".swarmforge/daemon"))
    (write-file (fs/path root ".swarmforge/roles.tsv")
                (str "coder\tmaster\t" root "\tsession\tCoder\tcodex\ttask\n"))
    (run {:dir root :ok? false}
         "sh" "-c"
         (str (script "handoffd.ts") " " root " >/dev/null 2>&1 &"))
    (Thread/sleep 1500)
    (let [pid-file (fs/path root ".swarmforge/daemon/handoffd.pid")]
      (is (fs/exists? pid-file))
      (let [pid (str/trim (read-file pid-file))
            stop (run {:dir root} (script "stop_handoff_daemon.ts") (str root))]
        (is (= 0 (:exit stop)))
        (Thread/sleep 300)
        (is (not (fs/exists? pid-file)))
        (is (not= 0 (:exit (run {:dir root :ok? false} "kill" "-0" pid))))))))

(deftest swarm-handoff-fills-artifacts-from-the-commit
  ;; Given a git_handoff of a commit that added a file
  ;; When it is queued
  ;; Then artifacts lists that file
  (let [root (tmp-dir)
        _ (init-repo! root)
        _ (setup-project! root)
        _ (write-file (fs/path root "slice.md") "work\n")
        _ (run {:dir root} "git" "add" "slice.md")
        _ (run {:dir root} "git" "commit" "-q" "-m" "Add slice")
        draft (fs/path root "tmp" "with-files.handoff")]
    (write-file draft "type: git_handoff\nto: receiver\npriority: 50\ntask: fill-artifacts\n")
    (let [result (audit-and-submit-git-handoff
                  {:dir root :env {"SWARMFORGE_ROLE" "sender"}} draft)
          queued (queued-path (:out result))
          content (read-file queued)]
      (is (zero? (:exit result)))
      (is (str/includes? content "artifacts: slice.md\n"))
      (is (not (str/includes? content "artifacts: none"))))))

(deftest swarm-handoff-includes-committed-task-document
  (let [root (tmp-dir)
        _ (init-repo! root)
        _ (setup-project! root)
        _ (write-file (fs/path root "tasks/htw.md") "# htw\n\nImplement the stories.\n")
        _ (run {:dir root} "git" "add" "tasks/htw.md")
        _ (run {:dir root} "git" "commit" "-q" "-m" "Add task document")
        draft (fs/path root "tmp" "task-doc.handoff")]
    (write-file draft "type: git_handoff\nto: receiver\npriority: 50\ntask: htw\n")
    (let [result (audit-and-submit-git-handoff
                  {:dir root :env {"SWARMFORGE_ROLE" "sender"}} draft)
          content (read-file (queued-path (:out result)))]
      (is (zero? (:exit result)))
      (is (str/includes? content "artifacts: tasks/htw.md\n")))))

(deftest swarm-handoff-excludes-deleted-artifacts
  ;; Given a commit deletes one file and changes another
  ;; When it is queued
  ;; Then the deleted file is not listed as an approval document
  (let [root (tmp-dir)
        _ (init-repo! root)
        _ (setup-project! root)
        _ (write-file (fs/path root "keep.md") "before\n")
        _ (write-file (fs/path root "gone.md") "delete me\n")
        _ (run {:dir root} "git" "add" "keep.md" "gone.md")
        _ (run {:dir root} "git" "commit" "-q" "-m" "Add docs")
        _ (write-file (fs/path root "keep.md") "after\n")
        _ (fs/delete (fs/path root "gone.md"))
        _ (run {:dir root} "git" "add" "keep.md" "gone.md")
        _ (run {:dir root} "git" "commit" "-q" "-m" "Update docs")
        draft (fs/path root "tmp" "deleted-artifact.handoff")]
    (write-file draft "type: git_handoff\nto: receiver\npriority: 50\ntask: docs\n")
    (let [result (audit-and-submit-git-handoff
                  {:dir root :env {"SWARMFORGE_ROLE" "sender"}} draft)
          queued (queued-path (:out result))
          content (read-file queued)]
      (is (zero? (:exit result)))
      (is (str/includes? content "artifacts: keep.md\n"))
      (is (not (str/includes? content "gone.md"))))))

(deftest swarm-handoff-uses-task-base-for-merge-artifacts
  ;; Given HEAD is a merge whose first-parent diff is unrelated to the current task
  ;; When a git_handoff is queued from an in-process task with a base commit
  ;; Then artifacts come from task_base_commit..HEAD, not HEAD^..HEAD
  (let [root (tmp-dir)
        _ (init-repo! root)
        _ (setup-project! root)
        base (head-sha root)
        _ (write-file (fs/path root ".swarmforge/board/tasks.tsv")
                      "extras\tsender\tcreated\tupdated\textras-id\n")
        _ (run {:dir root} "git" "checkout" "-q" "-b" "jump")
        _ (write-file (fs/path root "features/console/wumpus_jump.feature") "jump\n")
        _ (run {:dir root} "git" "add" "features/console/wumpus_jump.feature")
        _ (run {:dir root} "git" "commit" "-q" "-m" "Jump spec")
        jump (head-sha root)
        _ (run {:dir root} "git" "checkout" "-q" "master")
        _ (write-file (fs/path root "features/console/command_extras.feature") "commands\n")
        _ (write-file (fs/path root "features/console/holy_hand_grenade.feature") "grenade\n")
        _ (run {:dir root} "git" "add" "features/console/command_extras.feature"
                 "features/console/holy_hand_grenade.feature")
        _ (run {:dir root} "git" "commit" "-q" "-m" "Extras spec")
        _ (run {:dir root} "git" "merge" "--no-ff" "jump" "-m" "Merge jump into extras")
        merge-head (head-sha root)
        draft (fs/path root "tmp" "extras.handoff")]
    (put-handoff! root "in_process" "50_extras.handoff"
                  {:id "current"
                   :from "(New Task)"
                   :to "sender"
                   :recipient "sender"
                   :priority "50"
                   :type "note"
                   :task-id "extras-id"
                   :task "extras"
                   :task-base-commit jump
                   :body "extras"})
    (write-file draft (format "type: git_handoff\nto: receiver\npriority: 50\ntask: extras\ncommit: %s\n" base))
    (let [result (audit-and-submit-git-handoff
                  {:dir root :env {"SWARMFORGE_ROLE" "sender"}} draft)
          queued (queued-path (:out result))
          content (read-file queued)]
      (is (zero? (:exit result)))
      (is (str/includes? content (str "commit: " merge-head "\n")))
      (is (str/includes? content "artifacts: features/console/command_extras.feature,features/console/holy_hand_grenade.feature\n"))
      (is (not (str/includes? content "wumpus_jump.feature"))))))

(deftest swarm-handoff-refuses-a-merge-with-no-changed-files
  ;; Given HEAD is a merge whose first-parent diff is empty
  ;; When swarm_handoff queues a git_handoff
  ;; Then it refuses and does not write artifacts: none
  (let [root (tmp-dir)
        _ (init-repo! root)
        _ (setup-project! root)
        _ (run {:dir root} "git" "checkout" "-q" "-b" "side")
        _ (write-file (fs/path root "side.md") "side\n")
        _ (run {:dir root} "git" "add" "side.md")
        _ (run {:dir root} "git" "commit" "-q" "-m" "Side")
        _ (run {:dir root} "git" "checkout" "-q" "master")
        _ (run {:dir root} "git" "merge" "-q" "--no-ff" "-s" "ours" "-m" "Ours" "side")
        draft (fs/path root "tmp" "merge.handoff")]
    (write-file draft "type: git_handoff\nto: receiver\npriority: 50\ntask: merge-empty\n")
    (let [result (run {:dir root :env {"SWARMFORGE_ROLE" "sender"} :ok? false}
                      (script "swarm_handoff.sh") (str draft))
          outbox (fs/path root ".swarmforge" "handoffs" "outbox")
          queued (when (fs/exists? outbox) (fs/glob outbox "*.handoff"))]
      (is (not (zero? (:exit result))))
      (is (str/includes? (str (:err result) (:out result)) "no changed files"))
      (is (not (str/includes? (str (:err result) (:out result)) "artifacts: none")))
      (is (empty? queued))
      (is (fs/exists? draft)))))

(deftest receive-and-complete-infer-role-from-worktree
  ;; Given a receiver worktree and no SWARMFORGE_ROLE
  ;; When ready_for_next then done_with_current run there
  ;; Then they infer the role and accept / complete the task
  (let [root (tmp-dir)
        _ (init-repo! root)
        wt (add-worktree! root "receiver")
        _ (setup-project! root {"receiver" "task"})
        _ (write-file (fs/path root ".swarmforge" "roles.tsv")
                      (format "sender\tsender\t%s\tsession\tSender\tcodex\ttask\nreceiver\treceiver\t%s\tsession\tReceiver\tcodex\ttask\n"
                              root wt))]
    (doseq [dir [".swarmforge/handoffs/outbox/tmp"
                 ".swarmforge/handoffs/sent"
                 ".swarmforge/handoffs/failed"
                 ".swarmforge/handoffs/inbox/new"
                 ".swarmforge/handoffs/inbox/in_process"
                 ".swarmforge/handoffs/inbox/completed"]]
      (fs/create-dirs (fs/path wt dir)))
    (make-queued-handoff! wt "50_20260615T000001Z_000001_from_sender_to_receiver.handoff"
                          {:id "20260615T000001Z_000001_from_sender"
                           :task "task-inferred"})
    (let [lib (run {:dir wt :ok? false} (script "handoff_lib.ts") "role")
          ready (run {:dir wt :ok? false} (script "ready_for_next.sh"))
          done (run {:dir wt :ok? false} (script "done_with_current.sh"))]
      (is (zero? (:exit lib)))
      (is (= "receiver" (str/trim (:out lib))))
      (is (zero? (:exit ready)))
      (is (str/includes? (:out ready) "TASK_NAME: task-inferred"))
      (is (zero? (:exit done)))
      (is (str/includes? (:out done) "COMPLETED:"))
      (is (str/includes? (:out done) "NO_TASK")))))

(deftest merge-and-process-merges-the-inbound-commit
  ;; Given a receiver worktree behind a sender commit
  ;; When merge_and_process runs with that sender and SHA
  ;; Then the receiver HEAD contains the commit
  (let [root (tmp-dir)
        _ (init-repo! root)
        sender (add-worktree! root "sender")
        receiver (add-worktree! root "receiver")
        _ (setup-project! root)
        _ (write-file (fs/path root ".swarmforge" "roles.tsv")
                      (format "sender\tsender\t%s\tsession\tSender\tcodex\ttask\nreceiver\treceiver\t%s\tsession\tReceiver\tcodex\ttask\n"
                              sender receiver))
        _ (write-file (fs/path sender "slice.md") "from sender\n")
        _ (run {:dir sender} "git" "add" "slice.md")
        _ (run {:dir sender} "git" "commit" "-q" "-m" "Sender slice")
        sha (str/trim (:out (run {:dir sender} "git" "rev-parse" "--short=10" "HEAD")))
        result (run {:dir receiver :ok? false}
                    (script "merge_and_process.sh") "sender" sha)
        merged? (run {:dir receiver :ok? false}
                     "git" "merge-base" "--is-ancestor" sha "HEAD")]
    (is (zero? (:exit result)))
    (is (str/includes? (str (:out result) (:err result)) "MERGED:"))
    (is (zero? (:exit merged?)))
    (is (fs/exists? (fs/path receiver "slice.md")))))

(deftest ready-for-next-merges-an-inbound-git-handoff
  ;; Given a receiver worktree with a queued git_handoff
  ;; When ready_for_next runs
  ;; Then it merges that commit; the agent does not run git merge
  (let [root (tmp-dir)
        _ (init-repo! root)
        sender (add-worktree! root "sender")
        receiver (add-worktree! root "receiver")
        _ (setup-project! root)
        _ (write-file (fs/path root ".swarmforge" "roles.tsv")
                      (format "sender\tsender\t%s\tsession\tSender\tcodex\ttask\nreceiver\treceiver\t%s\tsession\tReceiver\tcodex\ttask\n"
                              sender receiver))
        _ (write-file (fs/path sender "slice.md") "from sender\n")
        _ (run {:dir sender} "git" "add" "slice.md")
        _ (run {:dir sender} "git" "commit" "-q" "-m" "Sender slice")
        sha (str/trim (:out (run {:dir sender} "git" "rev-parse" "--short=10" "HEAD")))]
    (doseq [dir [".swarmforge/handoffs/inbox/new"
                 ".swarmforge/handoffs/inbox/in_process"
                 ".swarmforge/handoffs/inbox/completed"]]
      (fs/create-dirs (fs/path receiver dir)))
    (make-queued-handoff! receiver "50_20260615T000001Z_000001_from_sender_to_receiver.handoff"
                          {:id "20260615T000001Z_000001_from_sender"
                           :from "sender"
                           :to "receiver"
                           :commit sha
                           :task "merge-on-receive"
                           :body (str "merge_and_process sender " sha)})
    (let [ready (run {:dir receiver :env {"SWARMFORGE_ROLE" "receiver"} :ok? false}
                     (script "ready_for_next.sh"))
          merged? (run {:dir receiver :ok? false}
                       "git" "merge-base" "--is-ancestor" sha "HEAD")]
      (is (zero? (:exit ready)))
      (is (str/includes? (:out ready) "TASK_NAME: merge-on-receive"))
      (is (zero? (:exit merged?)))
      (is (fs/exists? (fs/path receiver "slice.md"))))))

(deftest swarm-handoff-rejects-evidence-headers
  ;; Given a git draft with coverage: or a note with an extra header
  ;; When swarm_handoff validates it
  ;; Then the draft is invalid; notes stay type/to/priority/message
  (let [root (tmp-dir)
        _ (init-repo! root)
        _ (setup-project! root)]
    (testing "git_handoff with coverage: is invalid"
      (let [draft (fs/path root "tmp" "coverage.handoff")]
        (write-file draft "type: git_handoff\nto: receiver\npriority: 50\ntask: cave\ncoverage: 92\n")
        (let [result (run {:dir root :env {"SWARMFORGE_ROLE" "sender"} :ok? false}
                          (script "swarm_handoff.sh") (str draft))]
          (is (= 2 (:exit result)))
          (is (str/includes? (:err result) "unknown header 'coverage'"))
          (is (fs/exists? draft)))))
    (testing "note extra headers are invalid"
      (let [draft (fs/path root "tmp" "note-extra.handoff")]
        (write-file draft "type: note\nto: receiver\npriority: 50\nmessage: hello\ncoverage: 92\n")
        (let [result (run {:dir root :env {"SWARMFORGE_ROLE" "sender"} :ok? false}
                          (script "swarm_handoff.sh") (str draft))]
          (is (= 2 (:exit result)))
          (is (str/includes? (:err result) "unknown header 'coverage'"))
          (is (fs/exists? draft)))))
    (testing "note still accepts only type to priority message"
      (let [draft (fs/path root "tmp" "note-ok.handoff")]
        (write-file draft "type: note\nto: receiver\npriority: 50\nmessage: hello\n")
        (let [result (run {:dir root :env {"SWARMFORGE_ROLE" "sender"} :ok? false}
                          (script "swarm_handoff.sh") (str draft))]
          (is (zero? (:exit result)))
          (is (str/includes? (:out result) "HANDOFF QUEUED:"))
          (is (empty? (fs/glob (fs/path root ".swarmforge/handoffs") "audit_pending/**/*.edn"))))))))

(deftest swarm-handoff-fills-missing-or-invalid-priority
  ;; Given a git_handoff draft that omits priority, or writes priority: normal
  ;; When swarm_handoff queues it
  ;; Then the queued file has priority: 50
  (let [root (tmp-dir)
        _ (init-repo! root)
        _ (setup-project! root)
        _ (write-file (fs/path root "slice.md") "work\n")
        _ (run {:dir root} "git" "add" "slice.md")
        _ (run {:dir root} "git" "commit" "-q" "-m" "Add slice")]
    (testing "omitted priority becomes 50"
      (let [draft (fs/path root "tmp" "no-priority.handoff")]
        (write-file draft "type: git_handoff\nto: receiver\ntask: fill-priority\n")
        (let [result (audit-and-submit-git-handoff
                      {:dir root :env {"SWARMFORGE_ROLE" "sender"} :ok? false} draft)
              queued (queued-path (:out result))
              content (when (zero? (:exit result)) (read-file queued))]
          (is (zero? (:exit result)))
          (is (str/includes? (str content) "priority: 50\n")))))
    (testing "priority: normal becomes 50"
      (let [draft (fs/path root "tmp" "word-priority.handoff")]
        (write-file draft "type: git_handoff\nto: receiver\npriority: normal\ntask: fill-priority-word\n")
        (let [result (audit-and-submit-git-handoff
                      {:dir root :env {"SWARMFORGE_ROLE" "sender"} :ok? false} draft)
              queued (queued-path (:out result))
              content (when (zero? (:exit result)) (read-file queued))]
          (is (zero? (:exit result)))
          (is (str/includes? (str content) "priority: 50\n"))
          (is (not (str/includes? (str content) "priority: normal\n"))))))
    (testing "valid two-digit priority is kept"
      (let [draft (fs/path root "tmp" "keep-priority.handoff")]
        (write-file draft "type: git_handoff\nto: receiver\npriority: 00\ntask: keep-priority\n")
        (let [result (audit-and-submit-git-handoff
                      {:dir root :env {"SWARMFORGE_ROLE" "sender"} :ok? false} draft)
              queued (queued-path (:out result))
              content (when (zero? (:exit result)) (read-file queued))]
          (is (zero? (:exit result)))
          (is (str/includes? (str content) "priority: 00\n")))))))

(deftest swarm-handoff-strips-extra-draft-payload
  ;; Given a git_handoff draft with prose after the headers
  ;; When swarm_handoff queues it
  ;; Then it is valid and the queued body is the helper payload, not the prose
  (let [root (tmp-dir)
        _ (init-repo! root)
        _ (setup-project! root)
        _ (write-file (fs/path root "slice.md") "work\n")
        _ (run {:dir root} "git" "add" "slice.md")
        _ (run {:dir root} "git" "commit" "-q" "-m" "Add slice")
        sha (str/trim (:out (run {:dir root} "git" "rev-parse" "--short=10" "HEAD")))
        draft (fs/path root "tmp" "with-payload.handoff")]
    (write-file draft (str "type: git_handoff\nto: receiver\npriority: 50\ntask: strip-payload\n\n"
                           "Please merge this and run the tests.\n"))
    (let [result (audit-and-submit-git-handoff
                  {:dir root :env {"SWARMFORGE_ROLE" "sender"} :ok? false} draft)
          queued (queued-path (:out result))
          content (when (zero? (:exit result)) (read-file queued))]
      (is (zero? (:exit result)))
      (is (str/includes? (str content) (str "merge_and_process.sh sender " sha)))
      (is (not (str/includes? (str content) "Please merge this and run the tests."))))))

(deftest swarm-handoff-last-role-tags-git-handoff-non-forwarding
  ;; Given receiver is the last pack role
  ;; When it queues a git_handoff
  ;; Then the queued file has non-forwarding: true
  (let [root (tmp-dir)
        _ (init-repo! root)
        _ (setup-project! root)
        _ (write-file (fs/path root "slice.md") "work\n")
        _ (run {:dir root} "git" "add" "slice.md")
        _ (run {:dir root} "git" "commit" "-q" "-m" "Add slice")
        draft (fs/path root "tmp" "last-role.handoff")]
    (write-file draft "type: git_handoff\nto: sender\npriority: 00\ntask: HTW\n")
    (let [result (audit-and-submit-git-handoff
                  {:dir root :env {"SWARMFORGE_ROLE" "receiver"} :ok? false} draft)
          queued (queued-path (:out result))
          content (when (zero? (:exit result)) (read-file queued))]
      (is (zero? (:exit result)))
      (is (str/includes? (str content) "non-forwarding: true\n"))
      (is (= 1 (count (outbox-handoffs root)))))))

(deftest swarm-handoff-non-last-role-does-not-tag-non-forwarding
  ;; Given sender is not the last pack role
  ;; When it queues a git_handoff
  ;; Then the queued file has no non-forwarding header
  (let [root (tmp-dir)
        _ (init-repo! root)
        _ (setup-project! root)
        _ (write-file (fs/path root "slice.md") "work\n")
        _ (run {:dir root} "git" "add" "slice.md")
        _ (run {:dir root} "git" "commit" "-q" "-m" "Add slice")
        draft (fs/path root "tmp" "mid-role.handoff")]
    (write-file draft "type: git_handoff\nto: receiver\npriority: 50\ntask: HTW\n")
    (let [result (audit-and-submit-git-handoff
                  {:dir root :env {"SWARMFORGE_ROLE" "sender"} :ok? false} draft)
          queued (queued-path (:out result))
          content (when (zero? (:exit result)) (read-file queued))]
      (is (zero? (:exit result)))
      (is (not (str/includes? (str content) "non-forwarding:"))))))

(defn commit-work! [root]
  (write-file (fs/path root "slice.md") (str "work " (System/nanoTime) "\n"))
  (run {:dir root} "git" "add" "slice.md")
  (run {:dir root} "git" "commit" "-q" "-m" "Add slice")
  (head-sha root))

(defn queue-git-from! [root role to task]
  (let [draft (fs/path root "tmp" (str role "-" task ".handoff"))]
    (write-file draft (str "type: git_handoff\nto: " to "\npriority: 50\ntask: " task
                           "\n\nPlease also rewrite the layout.\n"))
    (audit-and-submit-git-handoff
     {:dir root :env {"SWARMFORGE_ROLE" role} :ok? false} draft)))

(def four-pack-role-rows
  [["specifier" "task" "forward-only"]
   ["coder" "task" "forward-only"]
   ["refactorer" "task" "back-one"]
   ["architect" "batch" "back-all"]])

(def six-pack-role-rows
  [["specifier" "task" "forward-only"]
   ["coder" "task" "forward-only"]
   ["cleaner" "task" "back-one"]
   ["architect" "batch" "back-all"]
   ["hardender" "task" "forward-only"]
   ["QA" "task" "back-all"]])

(deftest swarm-handoff-refactorer-back-one-writes-reverse-copy
  ;; Given four-pack refactorer back-one
  ;; When it queues git_handoff to architect
  ;; Then coder gets a separate non-forwarding 00 copy; architect is on to:
  (let [root (tmp-dir)
        _ (init-repo! root)
        _ (setup-project! root four-pack-role-rows)
        sha (commit-work! root)
        result (queue-git-from! root "refactorer" "architect" "HTW")
        forward (outbox-to root "architect")
        reverse (outbox-to root "coder")
        extra "Please also rewrite the layout."]
    (is (zero? (:exit result)))
    (is (some? forward))
    (is (some? reverse))
    (is (not= (str forward) (str reverse)))
    (is (str/starts-with? (fs/file-name reverse) "00_"))
    (is (str/starts-with? (fs/file-name forward) "50_"))
    (is (= "architect" (header forward "to")))
    (is (= "coder" (header reverse "to")))
    (is (not (str/includes? (header forward "to") "coder")))
    (is (= "true" (header reverse "non-forwarding")))
    (is (not= "true" (header forward "non-forwarding")))
    (is (str/includes? (handoff-body reverse) (str "merge_and_process.sh refactorer " sha)))
    (is (str/includes? (handoff-body reverse) "inbound tree is the structure"))
    (is (str/includes? (handoff-body forward) (str "merge_and_process.sh refactorer " sha)))
    (is (str/includes? (handoff-body forward) "current tree is the structure"))
    (is (not (str/includes? (handoff-body forward) "inbound tree is the structure")))
    (is (not (str/includes? (handoff-body forward) extra)))
    (is (not (str/includes? (handoff-body reverse) extra)))
    (is (= 2 (count (outbox-handoffs root))))))

(deftest swarm-handoff-architect-back-all-writes-upstream-copies
  ;; Given four-pack architect last with back-all
  ;; When it queues git_handoff
  ;; Then specifier, coder, and refactorer get merge-only copies
  (let [root (tmp-dir)
        _ (init-repo! root)
        _ (setup-project! root four-pack-role-rows)
        _ (commit-work! root)
        result (queue-git-from! root "architect" "specifier" "HTW")
        extra "Please also rewrite the layout."]
    (is (zero? (:exit result)))
    (doseq [role ["specifier" "coder" "refactorer"]]
      (let [copy (outbox-to root role)]
        (is (some? copy) role)
        (is (str/starts-with? (fs/file-name copy) "00_") role)
        (is (= "true" (header copy "non-forwarding")) role)
        (is (= role (header copy "to")) role)
        (is (str/includes? (handoff-body copy) "merge_and_process.sh architect"))
        (is (str/includes? (handoff-body copy) "inbound tree is the structure"))
        (is (not (str/includes? (handoff-body copy) extra)))))
    (let [forward (first (filter #(str/starts-with? (fs/file-name %) "50_")
                                 (outbox-handoffs root)))]
      (is (some? forward))
      (is (= "specifier" (header forward "to")))
      (is (= "true" (header forward "non-forwarding")))
      (is (str/includes? (handoff-body forward) "merge_and_process.sh architect"))
      (is (str/includes? (handoff-body forward) "inbound tree is the structure"))
      (is (not (str/includes? (handoff-body forward) "current tree is the structure")))
      (is (not (str/includes? (handoff-body forward) extra))))))

(deftest swarm-handoff-six-pack-architect-back-all-skips-downstream
  ;; Given six-pack architect back-all (not last)
  ;; When it queues git_handoff to hardender
  ;; Then specifier, coder, cleaner get reverse copies; QA does not
  (let [root (tmp-dir)
        _ (init-repo! root)
        _ (setup-project! root six-pack-role-rows)
        _ (commit-work! root)
        result (queue-git-from! root "architect" "hardender" "HTW")]
    (is (zero? (:exit result)))
    (is (= "hardender" (header (outbox-to root "hardender") "to")))
    (is (not= "true" (header (outbox-to root "hardender") "non-forwarding")))
    (doseq [role ["specifier" "coder" "cleaner"]]
      (is (= "true" (header (outbox-to root role) "non-forwarding")) role)
      (is (str/starts-with? (fs/file-name (outbox-to root role)) "00_") role))
    (is (nil? (outbox-to root "QA")))))

(deftest swarm-handoff-six-pack-qa-back-all-copies-every-earlier-window
  (let [root (tmp-dir)
        _ (init-repo! root)
        _ (setup-project! root six-pack-role-rows)
        _ (commit-work! root)
        result (queue-git-from! root "QA" "specifier" "HTW")]
    (is (zero? (:exit result)))
    (doseq [role ["specifier" "coder" "cleaner" "architect" "hardender"]]
      (is (some? (outbox-to root role)) role)
      (is (= "true" (header (outbox-to root role) "non-forwarding")) role))
    (let [forward (first (filter #(str/starts-with? (fs/file-name %) "50_")
                                 (outbox-handoffs root)))]
      (is (= "true" (header forward "non-forwarding"))))))

(deftest swarm-handoff-two-pack-cleaner-back-one-copies-coder
  (let [root (tmp-dir)
        _ (init-repo! root)
        _ (setup-project! root [["coder" "task" "forward-only"]
                                ["cleaner" "task" "back-one"]])
        _ (commit-work! root)
        result (queue-git-from! root "cleaner" "coder" "HTW")]
    (is (zero? (:exit result)))
    (is (= "true" (header (outbox-to root "coder") "non-forwarding")))
    (is (str/starts-with? (fs/file-name (outbox-to root "coder")) "00_"))
    (let [forward (first (filter #(str/starts-with? (fs/file-name %) "50_")
                                 (outbox-handoffs root)))]
      (is (= "true" (header forward "non-forwarding"))))))

(deftest swarm-handoff-last-window-forward-only-has-no-reverse-copies
  (let [root (tmp-dir)
        _ (init-repo! root)
        _ (setup-project! root [["coder" "task" "forward-only"]
                                ["cleaner" "task" "forward-only"]])
        _ (commit-work! root)
        result (queue-git-from! root "cleaner" "coder" "HTW")]
    (is (zero? (:exit result)))
    (is (= 1 (count (outbox-handoffs root))))
    (is (= "true" (header (outbox-to root "coder") "non-forwarding")))
    (is (str/includes? (handoff-body (outbox-to root "coder"))
                       "inbound tree is the structure"))
    (is (not (str/includes? (handoff-body (outbox-to root "coder"))
                            "current tree is the structure")))))

(deftest swarm-handoff-refuses-git-handoff-when-inbound-is-non-forwarding
  ;; Given an in-process inbound git_handoff tagged non-forwarding
  ;; When swarm_handoff queues another git_handoff
  ;; Then it refuses
  (let [root (tmp-dir)
        _ (init-repo! root)
        _ (setup-project! root)
        _ (write-file (fs/path root "slice.md") "work\n")
        _ (run {:dir root} "git" "add" "slice.md")
        _ (run {:dir root} "git" "commit" "-q" "-m" "Add slice")
        inbound (fs/path root ".swarmforge/handoffs/inbox/in_process/00_from_architect.handoff")
        draft (fs/path root "tmp" "forward.handoff")]
    (write-file inbound (str "from: architect\nto: sender\npriority: 00\ntype: git_handoff\n"
                             "task: HTW\nnon-forwarding: true\n\nmerge\n"))
    (write-file draft "type: git_handoff\nto: receiver\npriority: 50\ntask: HTW\n")
    (let [result (run {:dir root :env {"SWARMFORGE_ROLE" "sender"} :ok? false}
                      (script "swarm_handoff.sh") (str draft))]
      (is (not (zero? (:exit result))))
      (is (str/includes? (str (:err result) (:out result)) "non-forwarding"))
      (is (fs/exists? draft)))))

(deftest done-with-current-after-reverse-copy-does-not-queue-git-handoff
  ;; Given an in-process reverse git_handoff
  ;; When done_with_current runs
  ;; Then the inbound is completed and no outbox git_handoff is written
  (let [root (tmp-dir)
        _ (init-repo! root)
        _ (setup-project! root)
        inbound (fs/path root ".swarmforge/handoffs/inbox/in_process/00_from_architect.handoff")]
    (write-file inbound (str "from: architect\nto: sender\npriority: 00\ntype: git_handoff\n"
                             "task: HTW\nnon-forwarding: true\n\nmerge\n"))
    (let [result (run {:dir root :env {"SWARMFORGE_ROLE" "sender"}}
                      (script "done_with_current.sh"))
          completed (fs/path root ".swarmforge/handoffs/inbox/completed/00_from_architect.handoff")
          outbox (fs/glob (fs/path root ".swarmforge/handoffs/outbox") "*.handoff")]
      (is (zero? (:exit result)))
      (is (str/includes? (:out result) "COMPLETED:"))
      (is (fs/exists? completed))
      (is (not (fs/exists? inbound)))
      (is (empty? outbox)))))

(deftest swarm-handoff-keeps-draft-task-that-names-a-lane-card
  ;; Given Command syntax and Holy Hand Grenade cards in the sender lane
  ;; When swarm_handoff queues a git_handoff with task: Holy Hand Grenade
  ;; Then the queued file keeps that task name
  (let [root (tmp-dir)
        _ (init-repo! root)
        _ (setup-project! root)
        _ (write-file (fs/path root ".swarmforge" "board" "tasks.tsv")
                      (str "Command syntax\tsender\t2026-06-15T00:00:00Z\t2026-06-15T00:00:00Z\n"
                           "Holy Hand Grenade\tsender\t2026-06-15T00:00:01Z\t2026-06-15T00:00:01Z\n"))
        _ (write-file (fs/path root "slice.md") "work\n")
        _ (run {:dir root} "git" "add" "slice.md")
        _ (run {:dir root} "git" "commit" "-q" "-m" "Add slice")
        draft (fs/path root "tmp" "hhg.handoff")]
    (write-file draft "type: git_handoff\nto: receiver\npriority: 50\ntask: Holy Hand Grenade\n")
    (let [result (audit-and-submit-git-handoff
                  {:dir root :env {"SWARMFORGE_ROLE" "sender"} :ok? false} draft)
          queued (queued-path (:out result))
          content (when (zero? (:exit result)) (read-file queued))]
      (is (zero? (:exit result)))
      (is (str/includes? (str content) "task: Holy Hand Grenade\n"))
      (is (not (str/includes? (str content) "task: Command syntax\n"))))))

(deftest swarm-handoff-from-worktree-uses-master-outbox-when-roles-copied
  ;; Given a sender worktree with a copied roles.tsv
  ;; When swarm_handoff queues a git_handoff there
  ;; Then the file is on the master project outbox
  (let [root (tmp-dir)
        _ (init-repo! root)
        wt (add-worktree! root "sender")
        _ (setup-project! root {"sender" "task" "receiver" "task"})
        roles (format "sender\tsender\t%s\tsession\tSender\tcodex\ttask\nreceiver\treceiver\t%s\tsession\tReceiver\tcodex\ttask\n"
                      wt root)
        _ (write-file (fs/path root ".swarmforge" "roles.tsv") roles)
        _ (write-file (fs/path wt ".swarmforge" "roles.tsv") roles)
        _ (write-file (fs/path wt "slice.md") "from the worktree\n")
        _ (run {:dir wt} "git" "add" "slice.md")
        _ (run {:dir wt} "git" "commit" "-q" "-m" "Worktree slice")
        draft (fs/path wt "tmp" "copied-roles.handoff")]
    (write-file draft "type: git_handoff\nto: receiver\npriority: 50\ntask: copied-roles\n")
    (let [result (audit-and-submit-git-handoff
                  {:dir wt :env {"SWARMFORGE_ROLE" "sender"}} draft)
          queued (queued-path (:out result))]
      (is (zero? (:exit result)))
      (is (str/starts-with? (str (fs/canonicalize queued))
                           (str (fs/canonicalize (fs/path root ".swarmforge" "handoffs" "outbox")))))
      (is (not (str/includes? queued "/.worktrees/"))))))

(deftest swarm-handoff-queues-a-merge-with-first-parent-files
  ;; Given HEAD is a merge that added a file versus the first parent
  ;; When swarm_handoff queues a git_handoff
  ;; Then it succeeds and artifacts lists that file
  (let [root (tmp-dir)
        _ (init-repo! root)
        _ (setup-project! root)
        _ (run {:dir root} "git" "checkout" "-q" "-b" "side")
        _ (write-file (fs/path root "side.md") "side\n")
        _ (run {:dir root} "git" "add" "side.md")
        _ (run {:dir root} "git" "commit" "-q" "-m" "Side")
        _ (run {:dir root} "git" "checkout" "-q" "master")
        _ (write-file (fs/path root "main.md") "main\n")
        _ (run {:dir root} "git" "add" "main.md")
        _ (run {:dir root} "git" "commit" "-q" "-m" "Main")
        _ (run {:dir root} "git" "merge" "-q" "--no-edit" "side")
        draft (fs/path root "tmp" "merge-files.handoff")]
    (write-file draft "type: git_handoff\nto: receiver\npriority: 50\ntask: merge-files\n")
    (let [result (audit-and-submit-git-handoff
                  {:dir root :env {"SWARMFORGE_ROLE" "sender"} :ok? false} draft)
          queued (queued-path (:out result))
          content (when (zero? (:exit result)) (read-file queued))]
      (is (zero? (:exit result)))
      (is (str/includes? (str content) "artifacts:"))
      (is (str/includes? (str content) "side.md")))))

(deftest done-with-current-archives-the-completing-role-pane
  ;; Given a current task and a pane stub
  ;; When done_with_current runs
  ;; Then the completing role's session pane is archived
  (let [root (tmp-dir)]
    (init-repo! root)
    (setup-project! root {"receiver" "task"})
    (put-handoff! root "in_process" "50_20260615T000001Z_000001_from_sender_to_receiver.handoff"
                  {:id "20260615T000001Z_000001_from_sender"
                   :from "sender" :to "receiver" :recipient "receiver"
                   :priority "50" :type "git_handoff" :task "task-current"
                   :commit (head-sha root)})
    (let [result (run {:dir root :env {"SWARMFORGE_ROLE" "receiver"
                                       "SWARMFORGE_PANE_STUB" "receiver pane\n"}}
                      (script "done_with_current.sh"))
          pane (fs/path root ".swarmforge/sessions/receiver/pane.txt")]
      (is (zero? (:exit result)))
      (is (fs/exists? pane))
      (is (= "receiver pane\n" (read-file pane))))))

(deftest swarm-handoff-uses-top-in-process-batch-task-name
  ;; Given an in-process batch whose first item is Command syntax, and HTW still in the sender lane
  ;; When swarm_handoff queues a git_handoff drafted as HTW
  ;; Then the queued file uses Command syntax
  (let [root (tmp-dir)
        _ (init-repo! root)
        _ (setup-project! root {"sender" "batch" "receiver" "task"})
        batch (fs/path root ".swarmforge/handoffs/inbox/in_process/batch_20260824T182225Z_000001")
        _ (fs/create-dirs batch)
        _ (write-file (fs/path batch "50_20260824T181141Z_000002_from_coder_to_sender.handoff")
                      (handoff {:id "20260824T181141Z_000002_from_coder"
                                :from "coder" :to "sender" :recipient "sender"
                                :priority "50" :type "git_handoff" :task "Command syntax"
                                :commit (head-sha root)}))
        _ (write-file (fs/path batch "50_20260824T181302Z_000003_from_coder_to_sender.handoff")
                      (handoff {:id "20260824T181302Z_000003_from_coder"
                                :from "coder" :to "sender" :recipient "sender"
                                :priority "50" :type "git_handoff" :task "validate"
                                :commit (head-sha root)}))
        _ (write-file (fs/path root ".swarmforge" "board" "tasks.tsv")
                      (str "HTW\tsender\t2026-08-24T18:05:33Z\t2026-08-24T18:05:33Z\n"
                           "Command syntax\tsender\t2026-08-24T18:06:05Z\t2026-08-24T18:06:05Z\n"
                           "validate\tsender\t2026-08-24T18:06:45Z\t2026-08-24T18:06:45Z\n"))
        _ (write-file (fs/path root "slice.md") "work\n")
        _ (run {:dir root} "git" "add" "slice.md")
        _ (run {:dir root} "git" "commit" "-q" "-m" "Add slice")
        draft (fs/path root "tmp" "htw.handoff")]
    (write-file draft "type: git_handoff\nto: receiver\npriority: 00\ntask: HTW\n")
    (let [result (audit-and-submit-git-handoff
                  {:dir root :env {"SWARMFORGE_ROLE" "sender"} :ok? false} draft)
          queued (queued-path (:out result))
          content (when (zero? (:exit result)) (read-file queued))]
      (is (zero? (:exit result)))
      (is (str/includes? (str content) "task: Command syntax\n"))
      (is (not (str/includes? (str content) "task: HTW\n"))))))

(deftest helpers-refuse-wrong-current-work-shape
  (let [root (tmp-dir)
        batch (fs/path root ".swarmforge/handoffs/inbox/in_process/batch_20260615T000001Z_000001")]
    (init-repo! root)
    (setup-project! root {"receiver" "batch"})
    (fs/create-dirs batch)
    (write-file (fs/path batch "10_20260615T000001Z_000001_from_sender_to_receiver.handoff")
                (handoff {:id "20260615T000001Z_000001_from_sender"
                          :from "sender" :to "receiver" :recipient "receiver"
                          :priority "10" :type "git_handoff" :task "task-a"
                          :commit (head-sha root)}))
    (testing "task helpers refuse an in-process batch"
      (let [ready (run {:dir root :env {"SWARMFORGE_ROLE" "receiver"} :ok? false}
                       (script "ready_for_next_task.sh"))
            done (run {:dir root :env {"SWARMFORGE_ROLE" "receiver"} :ok? false}
                      (script "done_with_current_task.sh"))]
        (is (= 2 (:exit ready)))
        (is (str/includes? (:err ready) "TASK_IN_PROCESS_IS_BATCH"))
        (is (= 2 (:exit done)))
        (is (str/includes? (:err done) "CURRENT_WORK_IS_BATCH"))))))

(defn -main [& _]
  (let [{:keys [fail error]} (run-tests 'swarmforge.handoff-test)]
    (System/exit (+ fail error))))
