(ns swarmforge.pack-ui-test
  (:require [babashka.fs :as fs]
            [cheshire.core :as json]
            [clojure.edn :as edn]
            [clojure.java.shell :as sh]
            [clojure.string :as str]
            [clojure.test :refer [deftest is run-tests use-fixtures]]
            [swarmforge.fake-herdr :as fake-herdr]))

(def six-pack-roles ["specifier" "coder" "cleaner" "architect" "hardender" "QA"])

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
  (let [dir (fs/create-temp-dir {:prefix "swarmforge-pack-ui-test."})]
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

(defn pack-worktree [root roles role]
  (if (= role (first roles))
    (str root)
    (str (fs/path root ".worktrees" role))))

(defn setup-pack!
  ([root] (setup-pack! root ["specifier"]))
  ([root roles] (setup-pack! root roles {}))
  ([root roles propagation]
   (write-file
    (fs/path root ".swarmforge/roles.tsv")
    (apply str
           (map-indexed
            (fn [i role]
              (format "%s\t%s\t%s\t%s\t%s\tcodex\ttask\t%s\n"
                      role
                      (if (zero? i) "master" role)
                      (pack-worktree root roles role)
                      role
                      (str/capitalize role)
                      (get propagation role "forward-only")))
            roles)))
   (doseq [role roles
           dir [".swarmforge/handoffs/outbox"
                ".swarmforge/handoffs/sent"
                ".swarmforge/handoffs/failed"
                ".swarmforge/handoffs/inbox/new"]]
     (fs/create-dirs (fs/path (pack-worktree root roles role) dir)))
   (fs/create-dirs (fs/path root ".swarmforge/handoffs/pending_approval"))))

(defn pack-board
  ([root ok? & args]
   (apply run {:dir root :ok? ok?} (script "pack_board.sh") args)))

(defn set-backend!
  [root backend]
  (let [file (fs/path root ".swarmforge/roles.tsv")]
    (spit (str file)
          (str/replace (slurp (str file)) #"\tcodex\t" (str "\t" backend "\t")))))

(defn read-argv [path]
  (when (fs/exists? path)
    (->> (str/split-lines (slurp (str path)))
         (remove str/blank?)
         (mapv read-string))))

(defn create-task
  ([root name lane] (create-task root name lane true))
  ([root name lane ok?]
   (pack-board root ok?
               "create"
               "--root" (str root)
               "--name" name
               "--lane" lane
               "--text" "Integrate HTW stories")))

(defn list-tasks [root]
  (pack-board root true "list" "--root" (str root)))

(defn task-row [listed name]
  (some #(when (str/starts-with? % (str name "\t")) %)
        (str/split-lines listed)))

(defn task-lane [root name]
  (let [cols (str/split (or (task-row (:out (list-tasks root)) name) "") #"\t")]
    (nth cols 1 nil)))

(defn increment-audit! [root task-id]
  (pack-board root true "increment-audit" "--root" (str root) "--task-id" task-id))

(defn queue-handoff! [root {:keys [from to task artifacts non-forwarding priority body]}]
  (let [priority (or priority "50")]
    (write-file
     (fs/path root ".swarmforge/handoffs/outbox"
              (str priority "_from_" from "_to_" (str/replace to #"," "_") ".handoff"))
     (str "from: " from "\n"
          "to: " to "\n"
          "priority: " priority "\n"
          "type: git_handoff\n"
          "task: " task "\n"
          (when artifacts (str "artifacts: " artifacts "\n"))
          (when non-forwarding "non-forwarding: true\n")
          "\n"
          (or body "payload") "\n"))))

(defn handoff-names [dir]
  (if (fs/directory? dir)
    (->> (fs/list-dir dir)
         (filter #(str/ends-with? (fs/file-name %) ".handoff"))
         (mapv #(fs/file-name %)))
    []))

(defn pending-names [root]
  (handoff-names (fs/path root ".swarmforge/handoffs/pending_approval")))

(defn write-pending-audit! [root task-id]
  (write-file
   (fs/path root ".swarmforge/handoffs/audit_pending/sender" (str task-id ".edn"))
   (str (pr-str {:candidate {:version 1
                             :sender "specifier"
                             :task-id task-id
                             :type "git_handoff"}})
        "\n")))

(defn pending-audits [root]
  (let [dir (fs/path root ".swarmforge/handoffs/audit_pending")]
    (if (fs/directory? dir)
      (vec (fs/glob dir "**/*.edn"))
      [])))

(defn pending-audit-task-ids [root]
  (->> (pending-audits root)
       (map #(get-in (edn/read-string (slurp (str %))) [:candidate :task-id]))
       set))

(defn inbox-names [root roles role]
  (handoff-names (fs/path (pack-worktree root roles role)
                          ".swarmforge/handoffs/inbox/new")))

(defn in-process-dir [root roles role]
  (fs/path (pack-worktree root roles role)
           ".swarmforge/handoffs/inbox/in_process"))

(defn put-in-process! [root roles role {:keys [from task filename]}]
  (write-file
   (fs/path (in-process-dir root roles role)
            (or filename (str "50_from_" from "_to_" role ".handoff")))
   (str "from: " from "\n"
        "to: " role "\n"
        "priority: 50\n"
        "type: git_handoff\n"
        "task: " task "\n"
        "\n"
        "payload\n")))

(defn task-card [root name]
  (when-let [row (task-row (:out (list-tasks root)) name)]
    (let [[card lane _created _updated id audit] (str/split row #"\t" -1)]
      {:name card :lane lane :id id :audit_count (parse-long audit)})))

(defn swarmctl [root & args]
  (apply run {:dir root} (script "swarmctl.sh") (concat args ["--root" (str root)])))

(defn swarm-status [root]
  (json/parse-string (:out (swarmctl root "status" "--json")) true))

(defn start-herdr! [root sessions]
  (fake-herdr/add-agents! root sessions)
  root)

(defn stop-herdr! [root]
  (fs/delete-tree (fake-herdr/state-dir root)))

(defn handoffd-once
  ([root] (handoffd-once root nil))
  ([root env]
   (run {:dir root :env env} "bb" (script "handoffd.bb") "--once" (str root))))

(defn pane-path [root role task]
  (fs/path root ".swarmforge/sessions" role task "pane.txt"))

(defn role-pane-path [root role]
  (fs/path root ".swarmforge/sessions" role "pane.txt"))

(deftest pack-board-creates-a-task-in-the-master-lane
  ;; Given a pack with specifier on master
  ;; When New Task records name htw-console-app
  ;; Then the card sits in lane specifier
  (let [root (tmp-dir)
        _ (setup-pack! root)
        created (create-task root "htw-console-app" "specifier")
        listed (:out (list-tasks root))
        on-disk (slurp (str (fs/path root ".swarmforge/board/tasks.tsv")))
        cols (str/split (or (task-row listed "htw-console-app") "") #"\t")]
    (is (zero? (:exit created)))
    (is (= listed on-disk))
    (is (= "htw-console-app" (nth cols 0 nil)))
    (is (= "specifier" (nth cols 1 nil)))
    (is (re-matches #"\d{4}-\d{2}-\d{2}T.*Z" (nth cols 2 "")))
    (is (= (nth cols 2 nil) (nth cols 3 nil)))
    (is (= "0" (nth cols 5 nil)))))

(deftest new-task-writes-the-card-and-body
  ;; Given specifier is master
  ;; When create name=htw-console-app text="Integrate HTW stories…"
  ;; Then lane is specifier AND board/htw-console-app.txt has the text
  (let [root (tmp-dir)
        text "Integrate HTW stories…"]
    (write-file
     (fs/path root ".swarmforge/roles.tsv")
     (str "specifier\tmaster\t" root "\tsession\tSpecifier\tcodex\ttask\n"))
    (let [created (pack-board root true
                              "create"
                              "--root" (str root)
                              "--name" "htw-console-app"
                              "--lane" "specifier"
                              "--text" text)
          body (slurp (str (fs/path root ".swarmforge/board/htw-console-app.txt")))]
      (is (zero? (:exit created)))
      (is (= "specifier" (task-lane root "htw-console-app")))
      (is (= text body))
      (is (= (str "# htw-console-app\n\n" text "\n")
             (slurp (str (fs/path root "tasks/htw-console-app.md"))))))))

(deftest pack-board-serializes-concurrent-audit-increments
  (let [root (tmp-dir)
        _ (setup-pack! root)
        _ (create-task root "HTW" "specifier")
        task-id (:id (task-card root "HTW"))
        increments (doall (repeatedly 8 #(future (increment-audit! root task-id))))]
    (doseq [increment increments]
      @increment)
    (is (= 8 (:audit_count (task-card root "HTW"))))))

(deftest pack-board-lists-lanes-in-role-order
  ;; Given roles specifier, coder, QA
  ;; When pack_board lanes
  ;; Then it prints those roles in conf order
  (let [root (tmp-dir)
        _ (setup-pack! root ["specifier" "coder" "QA"])
        result (pack-board root true "lanes" "--root" (str root))]
    (is (= "specifier\ncoder\nQA\n" (:out result)))))

(deftest pack-board-reports-the-master-lane
  ;; Given specifier's worktree is master
  ;; When pack_board master-lane
  ;; Then it prints specifier
  (let [root (tmp-dir)]
    (write-file
     (fs/path root ".swarmforge/roles.tsv")
     (str "specifier\tmaster\t" root "\tsession\tSpecifier\tcodex\ttask\n"
          "coder\tcoder\t" root "/.worktrees/coder\tsession\tCoder\tcodex\ttask\n"))
    (let [result (pack-board root true "master-lane" "--root" (str root))]
      (is (= "specifier\n" (:out result))))))

(deftest pack-board-rejects-a-duplicate-task-name
  ;; Given a card named htw-console-app
  ;; When New Task records the same name again
  ;; Then the create is rejected and the original card is unchanged
  (let [root (tmp-dir)
        _ (setup-pack! root)
        _ (create-task root "htw-console-app" "specifier")
        before (:out (list-tasks root))
        duplicate (create-task root "htw-console-app" "specifier" false)
        after (:out (list-tasks root))]
    (is (not (zero? (:exit duplicate))))
    (is (str/includes? (str (:err duplicate) (:out duplicate)) "Duplicate"))
    (is (= before after))))

(deftest handoffd-moves-the-task-card-to-the-recipient
  ;; Given card htw-console-app in coder
  ;; When a git_handoff coder→cleaner for that task is delivered
  ;; Then the card lane is cleaner
  (let [root (tmp-dir)
        roles ["specifier" "coder" "cleaner"]
        sock (do (setup-pack! root roles)
                 (create-task root "htw-console-app" "coder")
                 (increment-audit! root (:id (task-card root "htw-console-app")))
                 (queue-handoff! root {:from "coder" :to "cleaner" :task "htw-console-app"})
                 (start-herdr! root roles))]
    (try
      (handoffd-once root)
      (is (= "cleaner" (task-lane root "htw-console-app")))
      (is (= 1 (:audit_count (task-card root "htw-console-app"))))
      (finally
        (stop-herdr! sock)))))

(deftest handoffd-marks-the-task-card-done-for-terminal-handoff
  ;; Given six-pack, card in QA (not master)
  ;; When QA queues git_handoff to every other role
  ;; Then the card lane is done
  (let [root (tmp-dir)
        to "specifier,coder,cleaner,architect,hardender"
        sock (do (setup-pack! root six-pack-roles)
                 (create-task root "htw-console-app" "QA")
                 (queue-handoff! root {:from "QA" :to to :task "htw-console-app"})
                 (start-herdr! root six-pack-roles))]
    (try
      (handoffd-once root)
      (is (= "done" (task-lane root "htw-console-app")))
      (finally
        (stop-herdr! sock)))))

(def four-pack-roles ["specifier" "coder" "refactorer" "architect"])
(def reverse-structure-body
  (str "Re-read your role and constitution.\n\n"
       "merge_and_process.sh refactorer abcdef1234\n\n"
       "The inbound tree is the structure. Replay this role's current task onto that shape."))

(deftest handoffd-refactorer-back-one-does-not-done-or-hold
  ;; Given four-pack, card in refactorer, reverse copy to coder and forward to architect
  ;; When handoffd delivers
  ;; Then coder gets the 00 reverse file, lane is architect, Attention is empty, card is not Done
  (let [root (tmp-dir)
        roles four-pack-roles
        sock (do (setup-pack! root roles {"refactorer" "back-one" "architect" "back-all"})
                 (create-task root "HTW" "refactorer")
                 (write-file
                  (fs/path (pack-worktree root roles "coder")
                           ".swarmforge/handoffs/inbox/new/50_next_card.handoff")
                  (str "from: specifier\nto: coder\npriority: 50\ntype: note\n"
                       "message: next card\n\nnote\n"))
                 (queue-handoff! root {:from "refactorer" :to "architect" :task "HTW"
                                       :priority "50"})
                 (queue-handoff! root {:from "refactorer" :to "coder" :task "HTW"
                                       :priority "00" :non-forwarding true
                                       :body reverse-structure-body})
                 (start-herdr! root roles))]
    (try
      (handoffd-once root)
      (let [coder-mail (sort (inbox-names root roles "coder"))
            delivered (slurp (str (fs/path (pack-worktree root roles "coder")
                                           ".swarmforge/handoffs/inbox/new"
                                           (first coder-mail))))]
        (is (str/starts-with? (first coder-mail) "00_"))
        (is (str/starts-with? (second coder-mail) "50_"))
        (is (str/includes? delivered "merge_and_process.sh refactorer"))
        (is (str/includes? delivered "inbound tree is the structure"))
        (is (str/includes? delivered "non-forwarding: true")))
      (is (seq (inbox-names root roles "architect")))
      (is (= [] (pending-names root)))
      (is (= "architect" (task-lane root "HTW")))
      (is (not= "done" (task-lane root "HTW")))
      (finally
        (stop-herdr! sock)))))

(deftest handoffd-four-pack-architect-back-all-dones-because-last
  (let [root (tmp-dir)
        roles four-pack-roles
        sock (do (setup-pack! root roles {"refactorer" "back-one" "architect" "back-all"})
                 (create-task root "HTW" "architect")
                 (queue-handoff! root {:from "architect" :to "specifier" :task "HTW"
                                       :priority "50" :non-forwarding true})
                 (doseq [role ["specifier" "coder" "refactorer"]]
                   (queue-handoff! root {:from "architect" :to role :task "HTW"
                                         :priority "00" :non-forwarding true
                                         :body reverse-structure-body}))
                 (start-herdr! root roles))]
    (try
      (handoffd-once root)
      (doseq [role ["specifier" "coder" "refactorer"]]
        (is (seq (inbox-names root roles role)) role))
      (is (= "done" (task-lane root "HTW")))
      (finally
        (stop-herdr! sock)))))

(deftest handoffd-six-pack-architect-back-all-moves-to-hardender
  (let [root (tmp-dir)
        roles six-pack-roles
        sock (do (setup-pack! root roles {"cleaner" "back-one"
                                          "architect" "back-all"
                                          "QA" "back-all"})
                 (create-task root "HTW" "architect")
                 (queue-handoff! root {:from "architect" :to "hardender" :task "HTW"
                                       :priority "50"})
                 (doseq [role ["specifier" "coder" "cleaner"]]
                   (queue-handoff! root {:from "architect" :to role :task "HTW"
                                         :priority "00" :non-forwarding true}))
                 (start-herdr! root roles))]
    (try
      (handoffd-once root)
      (doseq [role ["specifier" "coder" "cleaner"]]
        (is (seq (inbox-names root roles role)) role))
      (is (seq (inbox-names root roles "hardender")))
      (is (= [] (inbox-names root roles "QA")))
      (is (= "hardender" (task-lane root "HTW")))
      (is (not= "done" (task-lane root "HTW")))
      (finally
        (stop-herdr! sock)))))

(deftest handoffd-six-pack-qa-back-all-dones-because-last
  (let [root (tmp-dir)
        roles six-pack-roles
        sock (do (setup-pack! root roles {"cleaner" "back-one"
                                          "architect" "back-all"
                                          "QA" "back-all"})
                 (create-task root "HTW" "QA")
                 (queue-handoff! root {:from "QA" :to "specifier" :task "HTW"
                                       :priority "50" :non-forwarding true})
                 (doseq [role ["specifier" "coder" "cleaner" "architect" "hardender"]]
                   (queue-handoff! root {:from "QA" :to role :task "HTW"
                                         :priority "00" :non-forwarding true}))
                 (start-herdr! root roles))]
    (try
      (handoffd-once root)
      (doseq [role ["specifier" "coder" "cleaner" "architect" "hardender"]]
        (is (seq (inbox-names root roles role)) role))
      (is (= "done" (task-lane root "HTW")))
      (finally
        (stop-herdr! sock)))))

(deftest handoffd-two-pack-cleaner-back-one-dones-because-last
  (let [root (tmp-dir)
        roles ["coder" "cleaner"]
        sock (do (setup-pack! root roles {"cleaner" "back-one"})
                 (create-task root "HTW" "cleaner")
                 (queue-handoff! root {:from "cleaner" :to "coder" :task "HTW"
                                       :priority "50" :non-forwarding true})
                 (queue-handoff! root {:from "cleaner" :to "coder" :task "HTW"
                                       :priority "00" :non-forwarding true})
                 (start-herdr! root roles))]
    (try
      (handoffd-once root)
      (is (seq (inbox-names root roles "coder")))
      (is (= "done" (task-lane root "HTW")))
      (finally
        (stop-herdr! sock)))))

(deftest two-pack-end-broadcast-marks-the-card-done
  ;; Given two-pack, card in cleaner
  ;; When cleaner queues git_handoff to coder (every other role)
  ;; Then the card is done and coder inbox has the file
  (let [root (tmp-dir)
        roles ["coder" "cleaner"]
        sock (do (setup-pack! root roles)
                 (create-task root "htw-console-app" "cleaner")
                 (queue-handoff! root {:from "cleaner" :to "coder" :task "htw-console-app"})
                 (start-herdr! root roles))]
    (try
      (handoffd-once root)
      (is (= "done" (task-lane root "htw-console-app")))
      (is (seq (inbox-names root roles "coder")))
      (is (= [] (pending-names root)))
      (finally
        (stop-herdr! sock)))))

(deftest four-pack-end-broadcast-marks-the-card-done
  ;; Given four-pack, card in architect
  ;; When architect queues git_handoff to every other role
  ;; Then the card is done
  (let [root (tmp-dir)
        roles ["specifier" "coder" "refactorer" "architect"]
        sock (do (setup-pack! root roles)
                 (create-task root "htw-console-app" "architect")
                 (queue-handoff! root {:from "architect"
                                       :to "specifier,coder,refactorer"
                                       :task "htw-console-app"})
                 (start-herdr! root roles))]
    (try
      (handoffd-once root)
      (is (= "done" (task-lane root "htw-console-app")))
      (is (seq (inbox-names root roles "specifier")))
      (is (seq (inbox-names root roles "coder")))
      (is (seq (inbox-names root roles "refactorer")))
      (is (= [] (pending-names root)))
      (finally
        (stop-herdr! sock)))))

(deftest four-pack-last-role-git-handoff-is-done
  ;; Given four-pack, card in architect
  ;; When architect queues git_handoff to specifier,coder (not every other role)
  ;; Then the card is done because architect is last
  (let [root (tmp-dir)
        roles ["specifier" "coder" "refactorer" "architect"]
        sock (do (setup-pack! root roles)
                 (create-task root "htw-console-app" "architect")
                 (queue-handoff! root {:from "architect"
                                       :to "specifier,coder"
                                       :task "htw-console-app"})
                 (start-herdr! root roles))]
    (try
      (handoffd-once root)
      (is (= "done" (task-lane root "htw-console-app")))
      (finally
        (stop-herdr! sock)))))

(deftest four-pack-one-recipient-non-forwarding-is-done
  ;; Given four-pack, card in architect
  ;; When architect queues a non-forwarding git_handoff to specifier only
  ;; Then the card is done, not moved to specifier
  (let [root (tmp-dir)
        roles ["specifier" "coder" "refactorer" "architect"]
        sock (do (setup-pack! root roles)
                 (create-task root "HTW" "architect")
                 (queue-handoff! root {:from "architect"
                                       :to "specifier"
                                       :task "HTW"
                                       :non-forwarding true})
                 (start-herdr! root roles))]
    (try
      (handoffd-once root)
      (is (= "done" (task-lane root "HTW")))
      (is (seq (inbox-names root roles "specifier")))
      (finally
        (stop-herdr! sock)))))

(deftest terminal-handoff-dones-finished-batch-cards-in-sender-lane
  ;; Given two-pack, Command syntax and validation in cleaner, those names in a
  ;; completed cleaner batch, HTW still in cleaner but not in that batch
  ;; When cleaner queues a terminal git_handoff named HTW
  ;; Then Command syntax and validation are done and HTW is done
  (let [root (tmp-dir)
        roles ["coder" "cleaner"]
        batch (fs/path (pack-worktree root roles "cleaner")
                       ".swarmforge/handoffs/inbox/completed"
                       "batch_20260824T150500Z_000001")
        sock (do (setup-pack! root roles)
                 (create-task root "HTW" "cleaner")
                 (create-task root "Command syntax" "cleaner")
                 (create-task root "validation" "cleaner")
                 (write-file (fs/path batch "50_command.handoff")
                             "from: coder\nto: cleaner\npriority: 50\ntype: git_handoff\ntask: Command syntax\n\npayload\n")
                 (write-file (fs/path batch "50_validation.handoff")
                             "from: coder\nto: cleaner\npriority: 50\ntype: git_handoff\ntask: validation\n\npayload\n")
                 (queue-handoff! root {:from "cleaner" :to "coder" :task "HTW"})
                 (start-herdr! root roles))]
    (try
      (handoffd-once root)
      (is (= "done" (task-lane root "HTW")))
      (is (= "done" (task-lane root "Command syntax")))
      (is (= "done" (task-lane root "validation")))
      (finally
        (stop-herdr! sock)))))

(deftest terminal-handoff-leaves-unfinished-lane-cards
  ;; Given two-pack, HTW finished in a completed batch, Command syntax only in the lane
  ;; When cleaner terminals with task HTW
  ;; Then HTW is done and Command syntax stays in cleaner
  (let [root (tmp-dir)
        roles ["coder" "cleaner"]
        done (fs/path (pack-worktree root roles "cleaner")
                      ".swarmforge/handoffs/inbox/completed")
        sock (do (setup-pack! root roles)
                 (create-task root "HTW" "cleaner")
                 (create-task root "Command syntax" "cleaner")
                 (write-file (fs/path done "50_htw.handoff")
                             "from: coder\nto: cleaner\npriority: 50\ntype: git_handoff\ntask: HTW\n\npayload\n")
                 (queue-handoff! root {:from "cleaner" :to "coder" :task "HTW"})
                 (start-herdr! root roles))]
    (try
      (handoffd-once root)
      (is (= "done" (task-lane root "HTW")))
      (is (= "cleaner" (task-lane root "Command syntax")))
      (finally
        (stop-herdr! sock)))))

(deftest terminal-handoff-dones-in-process-batch-cards
  ;; Given two-pack, one liners/validate/HHG in an in-process cleaner batch,
  ;; and Command syntax in cleaner but not in that batch
  ;; When cleaner terminals with task one liners before done_with_current
  ;; Then the three batch cards are done and Command syntax stays in cleaner
  (let [root (tmp-dir)
        roles ["coder" "cleaner"]
        batch (fs/path (in-process-dir root roles "cleaner")
                       "batch_20260824T202830Z_000001")
        sock (do (setup-pack! root roles)
                 (create-task root "one liners" "cleaner")
                 (create-task root "validate" "cleaner")
                 (create-task root "Holy Hand Grenade" "cleaner")
                 (create-task root "Command syntax" "cleaner")
                 (write-file (fs/path batch "50_oneliners.handoff")
                             "from: coder\nto: cleaner\npriority: 50\ntype: git_handoff\ntask: one liners\n\npayload\n")
                 (write-file (fs/path batch "50_validate.handoff")
                             "from: coder\nto: cleaner\npriority: 50\ntype: git_handoff\ntask: validate\n\npayload\n")
                 (write-file (fs/path batch "50_hhg.handoff")
                             "from: coder\nto: cleaner\npriority: 50\ntype: git_handoff\ntask: Holy Hand Grenade\n\npayload\n")
                 (queue-handoff! root {:from "cleaner" :to "coder" :task "one liners"})
                 (start-herdr! root roles))]
    (try
      (handoffd-once root)
      (is (= "done" (task-lane root "one liners")))
      (is (= "done" (task-lane root "validate")))
      (is (= "done" (task-lane root "Holy Hand Grenade")))
      (is (= "cleaner" (task-lane root "Command syntax")))
      (finally
        (stop-herdr! sock)))))

(deftest six-pack-qa-broadcast-marks-the-card-done
  ;; Given six-pack, card in QA
  ;; When QA queues git_handoff to every other role
  ;; Then the card is done
  (let [root (tmp-dir)
        others "specifier,coder,cleaner,architect,hardender"
        sock (do (setup-pack! root six-pack-roles)
                 (create-task root "htw-console-app" "QA")
                 (queue-handoff! root {:from "QA" :to others :task "htw-console-app"})
                 (start-herdr! root six-pack-roles))]
    (try
      (handoffd-once root)
      (is (= "done" (task-lane root "htw-console-app")))
      (is (seq (inbox-names root six-pack-roles "specifier")))
      (is (seq (inbox-names root six-pack-roles "hardender")))
      (is (= [] (pending-names root)))
      (finally
        (stop-herdr! sock)))))

(def example-task-text
  "Integrate the stories in ~/junk/htw-stories into one console application.")

(def example-task-payload
  (str "Task: htw-console-app\n\n" example-task-text))

(deftest handoffd-archives-sender-pane-when-task-moves
  ;; Given card and specifier→coder handoff (two-pack coder→cleaner to skip attention)
  ;; When delivered
  ;; Then .swarmforge/sessions/<from>/<task>/pane.txt exists
  (let [root (tmp-dir)
        roles ["coder" "cleaner"]
        sock (do (setup-pack! root roles)
                 (create-task root "htw-console-app" "coder")
                 (queue-handoff! root {:from "coder" :to "cleaner" :task "htw-console-app"})
                 (start-herdr! root roles))]
    (try
      (handoffd-once root {"SWARMFORGE_PANE_STUB" "pane\n"})
      (let [pane (role-pane-path root "coder")]
        (is (fs/exists? pane))
        (is (= "pane\n" (slurp (str pane))))
        (is (not (fs/exists? (pane-path root "coder" "htw-console-app")))))
      (finally
        (stop-herdr! sock)))))

(deftest pack-board-archives-live-role-panes
  ;; Given a two-pack with a live card in coder and a done card
  ;; When pack_board archive-all with SWARMFORGE_PANE_STUB
  ;; Then coder's pane.txt exists and the done card is skipped
  (let [root (tmp-dir)
        roles ["coder" "cleaner"]]
    (setup-pack! root roles)
    (create-task root "htw-console-app" "coder")
    (create-task root "already-done" "done")
    (let [result (run {:dir root :env {"SWARMFORGE_PANE_STUB" "pane\n"}}
                      (script "pack_board.sh")
                      "archive-all" "--root" (str root))]
      (is (zero? (:exit result)))
      (is (= "pane\n" (slurp (str (role-pane-path root "coder")))))
      (is (not (fs/exists? (role-pane-path root "done"))))
      (is (not (fs/exists? (pane-path root "coder" "htw-console-app")))))))

(deftest close-swarm-archives-live-role-panes
  ;; Given a two-pack with a live card in coder
  ;; When close-swarm
  ;; Then coder's pane.txt is archived
  (let [root (tmp-dir)
        roles ["coder" "cleaner"]]
    (setup-pack! root roles)
    (create-task root "htw-console-app" "coder")
    (let [result (run {:dir root
                       :env {"SWARMFORGE_PANE_STUB" "pane\n"}}
                      (str (fs/path repo-root "close-swarm"))
                      (str root))]
      (is (zero? (:exit result)))
      (is (= "pane\n" (slurp (str (role-pane-path root "coder"))))))))

(deftest pack-board-move-matches-task-name-ignoring-case
  ;; Given board card HTW
  ;; When pack_board move --name htw --lane coder
  ;; Then the card HTW is in coder
  (let [root (tmp-dir)]
    (setup-pack! root)
    (create-task root "HTW" "specifier")
    (pack-board root true "move" "--root" (str root) "--name" "htw" "--lane" "coder")
    (is (= "coder" (task-lane root "HTW")))))

(deftest handoffd-moves-card-when-handoff-task-case-differs
  ;; Given card HTW in coder
  ;; When git_handoff coder→cleaner task htw is delivered
  ;; Then HTW is in cleaner
  (let [root (tmp-dir)
        roles ["coder" "cleaner"]
        sock (do (setup-pack! root roles)
                 (create-task root "HTW" "coder")
                 (queue-handoff! root {:from "coder" :to "cleaner" :task "htw"})
                 (start-herdr! root roles))]
    (try
      (handoffd-once root)
      (is (= "cleaner" (task-lane root "HTW")))
      (finally
        (stop-herdr! sock)))))

(deftest handoffd-does-not-deliver-when-board-task-is-unknown
  ;; Given card HTW and a handoff for other-task
  ;; When delivered
  ;; Then coder inbox stays empty and HTW stays in specifier
  (let [root (tmp-dir)
        roles ["coder" "cleaner"]
        sock (do (setup-pack! root roles)
                 (create-task root "HTW" "coder")
                 (queue-handoff! root {:from "coder" :to "cleaner" :task "other-task"})
                 (start-herdr! root roles))]
    (try
      (handoffd-once root)
      (is (= "coder" (task-lane root "HTW")))
      (is (= [] (inbox-names root roles "cleaner")))
      (finally
        (stop-herdr! sock)))))

(deftest specifier-git-handoff-waits-for-approval
  ;; Given six-pack-shaped roles + card in specifier
  ;; When specifier→coder is queued and handoffd --once
  ;; Then the file is held in pending_approval, the coder inbox is empty, and status lists it
  (let [root (tmp-dir)
        artifacts "features/console.feature,qa/console.md"
        sock (do (setup-pack! root six-pack-roles)
                 (create-task root "htw-console-app" "specifier")
                 (increment-audit! root (:id (task-card root "htw-console-app")))
                 (queue-handoff! root {:from "specifier" :to "coder" :task "htw-console-app"
                                       :artifacts artifacts})
                 (start-herdr! root six-pack-roles))]
    (try
      (handoffd-once root)
      (is (= ["50_from_specifier_to_coder.handoff"] (pending-names root)))
      (is (= [] (inbox-names root six-pack-roles "coder")))
      (is (= "specifier" (task-lane root "htw-console-app")))
      (is (= 1 (:audit_count (task-card root "htw-console-app"))))
      (let [status (swarm-status root)]
        (is (= [{:id "50_from_specifier_to_coder" :task "htw-console-app" :from "specifier" :to "coder"
                 :artifacts ["features/console.feature" "qa/console.md"]}]
               (map #(select-keys % [:id :task :from :to :artifacts]) (:approvals status))))
        (is (= "waiting for your approval" (:status (first (:tasks status))))))
      (finally
        (stop-herdr! sock)))))

(deftest two-pack-git-handoff-does-not-wait
  ;; Given coder master, cleaner next, no specifier
  ;; When coder→cleaner queued + --once
  ;; Then it is delivered to cleaner and nothing waits for approval
  (let [root (tmp-dir)
        roles ["coder" "cleaner"]
        sock (do (setup-pack! root roles)
                 (create-task root "htw-console-app" "coder")
                 (queue-handoff! root {:from "coder" :to "cleaner" :task "htw-console-app"})
                 (start-herdr! root roles))]
    (try
      (handoffd-once root)
      (is (seq (inbox-names root roles "cleaner")))
      (is (= [] (pending-names root)))
      (is (= "cleaner" (task-lane root "htw-console-app")))
      (is (= [] (:approvals (swarm-status root))))
      (finally
        (stop-herdr! sock)))))

(deftest swarm-approve-releases-the-held-handoff
  ;; Given a spec held for approval
  ;; When the operator runs swarm approve and handoffd runs again
  ;; Then the coder has it, the card moves to coder, and nothing is pending
  (let [root (tmp-dir)
        sock (do (setup-pack! root six-pack-roles)
                 (create-task root "htw-console-app" "specifier")
                 (increment-audit! root (:id (task-card root "htw-console-app")))
                 (queue-handoff! root {:from "specifier" :to "coder" :task "htw-console-app"
                                       :artifacts "features/console.feature"})
                 (start-herdr! root six-pack-roles))]
    (try
      (handoffd-once root)
      (swarmctl root "approve" "htw-console-app")
      (handoffd-once root)
      (is (seq (inbox-names root six-pack-roles "coder")))
      (is (= "coder" (task-lane root "htw-console-app")))
      (is (= 1 (:audit_count (task-card root "htw-console-app"))))
      (is (= [] (pending-names root)))
      (is (= [] (:approvals (swarm-status root))))
      (finally
        (stop-herdr! sock)))))

(deftest swarm-reject-sends-the-spec-back-with-the-comments
  ;; Given a spec held for approval
  ;; When the operator runs swarm reject with comments
  ;; Then nothing is pending or delivered, the audit count grows, and the specifier is prompted
  (let [root (tmp-dir)
        sock (do (setup-pack! root six-pack-roles)
                 (create-task root "htw-console-app" "specifier")
                 (increment-audit! root (:id (task-card root "htw-console-app")))
                 (queue-handoff! root {:from "specifier" :to "coder" :task "htw-console-app"
                                       :artifacts "features/console.feature"})
                 (start-herdr! root six-pack-roles))]
    (try
      (handoffd-once root)
      (swarmctl root "reject" "50_from_specifier" "Split the login" "scenario")
      (handoffd-once root)
      (is (= [] (pending-names root)))
      (is (= [] (inbox-names root six-pack-roles "coder")))
      (is (= "specifier" (task-lane root "htw-console-app")))
      (is (= 2 (:audit_count (task-card root "htw-console-app"))))
      (let [[agent text] (last (fake-herdr/prompts root))]
        (is (= "specifier" agent))
        (is (str/includes? text "Split the login scenario"))
        (is (str/includes? text "send a new git_handoff to coder")))
      (finally
        (stop-herdr! sock)))))

(deftest swarm-task-new-reaches-the-master-without-moving-the-card
  ;; Given a project with a master role
  ;; When the operator runs swarm task new and handoffd runs
  ;; Then the master inbox has the note, the card stays in the master lane, and sent is on master
  (let [root (tmp-dir)
        roles six-pack-roles
        sock (do (setup-pack! root roles)
                 (swarmctl root "task" "new" "HTW" "Print hello")
                 (start-herdr! root roles))]
    (try
      (handoffd-once root)
      (is (= "specifier" (task-lane root "HTW")))
      (is (= [] (pending-names root)))
      (is (seq (inbox-names root roles "specifier")))
      (is (seq (handoff-names (fs/path root ".swarmforge/handoffs/sent"))))
      (is (empty? (handoff-names (fs/path (pack-worktree root roles "coder")
                                         ".swarmforge/handoffs/sent"))))
      (finally
        (stop-herdr! sock)))))

(defn -main [& _]
  (let [{:keys [fail error]} (run-tests 'swarmforge.pack-ui-test)]
    (System/exit (+ fail error))))