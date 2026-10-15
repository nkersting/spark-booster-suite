import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { hasRole } from "@/lib/roles";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, Shield, Users, Trash2, KeyRound, UserPlus, Plus, Pencil } from "lucide-react";
import { toast } from "sonner";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

type AppRole = "admin" | "beta-user" | "user" | "disabled";

interface UserWithRole {
  user_id: string;
  display_name: string | null;
  email: string;
  created_at: string;
  role: AppRole;
}

interface LicenseRow {
  code: string;
  tier: string;
  max_users: number;
  max_sessions: number | null;
  sessions_used: number;
  active_users: number;
  buyer_email: string | null;
  active: boolean;
  created_at: string;
}

interface LicenseUserRow {
  license_code: string;
  user_email: string;
  created_at: string;
}

export default function Admin() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [users, setUsers] = useState<UserWithRole[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [checkingAdmin, setCheckingAdmin] = useState(true);
  const [updatingRole, setUpdatingRole] = useState<string | null>(null);
  const [deletingUser, setDeletingUser] = useState<string | null>(null);
  const [licenses, setLicenses] = useState<LicenseRow[]>([]);
  const [licenseUsers, setLicenseUsers] = useState<LicenseUserRow[]>([]);
  const [expandedLicense, setExpandedLicense] = useState<string | null>(null);

  // Add-user dialog
  const [addUserOpen, setAddUserOpen] = useState(false);
  const [newUserEmail, setNewUserEmail] = useState("");
  const [newUserPassword, setNewUserPassword] = useState("");
  const [newUserName, setNewUserName] = useState("");
  const [newUserRole, setNewUserRole] = useState<AppRole>("user");
  const [creatingUser, setCreatingUser] = useState(false);

  // Add-license dialog
  const [addLicenseOpen, setAddLicenseOpen] = useState(false);
  const [newLicCode, setNewLicCode] = useState("");
  const [newLicTier, setNewLicTier] = useState("solo");
  const [newLicMaxUsers, setNewLicMaxUsers] = useState("1");
  const [newLicMaxSessions, setNewLicMaxSessions] = useState("");
  const [newLicBuyer, setNewLicBuyer] = useState("");
  const [creatingLicense, setCreatingLicense] = useState(false);

  // Edit-license dialog
  const [editLicenseOpen, setEditLicenseOpen] = useState(false);
  const [editLicOriginalCode, setEditLicOriginalCode] = useState("");
  const [editLicCode, setEditLicCode] = useState("");
  const [editLicTier, setEditLicTier] = useState("solo");
  const [editLicMaxUsers, setEditLicMaxUsers] = useState("1");
  const [editLicMaxSessions, setEditLicMaxSessions] = useState("");
  const [editLicSessionsUsed, setEditLicSessionsUsed] = useState("0");
  const [editLicActiveUsers, setEditLicActiveUsers] = useState("0");
  const [editLicBuyer, setEditLicBuyer] = useState("");
  const [editLicActive, setEditLicActive] = useState(true);
  const [savingLicense, setSavingLicense] = useState(false);
  const [deletingLicense, setDeletingLicense] = useState<string | null>(null);

  // Workaround for Radix Select-inside-Dialog leaving body pointer-events:none,
  // which makes subsequent button clicks silently do nothing (the "hang").
  useEffect(() => {
    if (!addLicenseOpen && !addUserOpen) {
      const id = setTimeout(() => {
        if (document.body.style.pointerEvents === "none") {
          document.body.style.pointerEvents = "";
        }
      }, 0);
      return () => clearTimeout(id);
    }
  }, [addLicenseOpen, addUserOpen]);

  useEffect(() => {
    if (!editLicenseOpen) {
      const id = setTimeout(() => {
        if (document.body.style.pointerEvents === "none") {
          document.body.style.pointerEvents = "";
        }
      }, 0);
      return () => clearTimeout(id);
    }
  }, [editLicenseOpen]);

  // Check if current user is admin
  useEffect(() => {
    async function checkAdminStatus() {
      if (loading) return; // Wait for auth to finish loading
      
      if (!user) {
        setCheckingAdmin(false);
        return;
      }

      try {
        // Prefer backend role function to avoid RLS edge-cases.
        const ok = await hasRole(user.id, "admin");
        setIsAdmin(ok);
      } catch (err) {
        console.error("Error in admin check:", err);
        setIsAdmin(false);
      }
      setCheckingAdmin(false);
    }

    checkAdminStatus();
  }, [user, loading]);

  async function fetchUsers() {
    if (!isAdmin) return;

      // Use the secure RPC function that requires admin role
      const { data: usersData, error: fetchError } = await supabase
        .rpc("get_all_users_admin");

      if (fetchError) {
        console.error("Error fetching users:", fetchError);

        const msg = fetchError.message || "Failed to load users";

        // Common auth/session failures from the API layer.
        const lower = msg.toLowerCase();
        if (
          lower.includes("jwt") ||
          lower.includes("not authenticated") ||
          lower.includes("missing authorization") ||
          lower.includes("invalid token")
        ) {
          toast.error("Session expired — please sign in again.");
          navigate("/auth");
          return;
        }

        toast.error(msg);
        return;
      }

      // Map the RPC result to our UserWithRole type
      const usersWithRoles: UserWithRole[] = (usersData || []).map((u: any) => ({
        user_id: u.user_id,
        display_name: u.display_name,
        email: u.email || "Unknown",
        created_at: u.created_at,
        role: (u.role as AppRole) || "user",
      }));

      setUsers(usersWithRoles);
  }

  useEffect(() => {
    if (isAdmin) {
      fetchUsers();
    }
  }, [isAdmin, user]);

  async function fetchLicenses() {
    if (!isAdmin) return;
    const [{ data: lic, error: licErr }, { data: lu, error: luErr }] = await Promise.all([
      supabase.from("licenses").select("*").order("created_at", { ascending: false }),
      supabase.from("license_users").select("license_code, user_email, created_at"),
    ]);
    if (licErr) { toast.error(licErr.message); return; }
    if (luErr) { toast.error(luErr.message); return; }
    setLicenses((lic || []) as LicenseRow[]);
    setLicenseUsers((lu || []) as LicenseUserRow[]);
  }
  useEffect(() => {
    fetchLicenses();
  }, [isAdmin]);

  const handleCreateUser = async () => {
    if (!newUserEmail.trim() || newUserPassword.length < 8) {
      toast.error("Email and password (≥8 chars) required");
      return;
    }
    setCreatingUser(true);
    const { data, error } = await supabase.functions.invoke("admin-create-user", {
      body: {
        email: newUserEmail.trim(),
        password: newUserPassword,
        displayName: newUserName.trim() || null,
        role: newUserRole,
      },
    });
    setCreatingUser(false);
    if (error || (data as any)?.error) {
      toast.error((data as any)?.error || error?.message || "Failed to create user");
      return;
    }
    toast.success(`User ${newUserEmail} created`);
    setAddUserOpen(false);
    setNewUserEmail(""); setNewUserPassword(""); setNewUserName(""); setNewUserRole("user");
    fetchUsers();
  };

  const generateLicenseCode = () => {
    const hex = crypto.randomUUID().replace(/-/g, "").toUpperCase();
    const tierPrefix = newLicTier === "free" ? "FREE" : newLicTier.slice(0, 4).toUpperCase();
    setNewLicCode(`${tierPrefix}-${hex.slice(0, 4)}-${hex.slice(4, 8)}`);
  };

  const handleCreateLicense = async () => {
    // Radix Select-inside-Dialog can leave body pointer-events:none, silently
    // swallowing this click. Force-reset before doing anything.
    document.body.style.pointerEvents = "";
    const code = newLicCode.trim();
    if (!code) { toast.error("Code required"); return; }
    const maxUsers = parseInt(newLicMaxUsers, 10);
    if (!Number.isFinite(maxUsers) || maxUsers < 1) { toast.error("Max users must be ≥1"); return; }
    const maxSessions = newLicMaxSessions.trim() === "" ? null : parseInt(newLicMaxSessions, 10);
    if (maxSessions !== null && (!Number.isFinite(maxSessions) || maxSessions < 0)) {
      toast.error("Max sessions invalid"); return;
    }
    setCreatingLicense(true);
    try {
      const createRequest = supabase.functions.invoke("admin-create-license", {
        body: {
          code,
          tier: newLicTier,
          max_users: maxUsers,
          max_sessions: maxSessions,
          buyer_email: newLicBuyer.trim() || null,
        },
      });
      const timeout = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("License creation timed out. Please try again.")), 12000);
      });
      const { data, error } = await Promise.race([createRequest, timeout]);
      if (error || (data as any)?.error) {
        const message = (data as any)?.error || error?.message || "Failed to create license";
        console.error("Create license error:", { error, data });
        toast.error(message);
        return;
      }
    } catch (err) {
      console.error("Create license exception:", err);
      toast.error(err instanceof Error ? err.message : "Failed to create license");
      return;
    } finally {
      setCreatingLicense(false);
    }
    toast.success(`License ${code} created`);
    setAddLicenseOpen(false);
    setNewLicCode(""); setNewLicBuyer(""); setNewLicMaxUsers("1"); setNewLicMaxSessions(""); setNewLicTier("solo");
    fetchLicenses();
  };

  const openEditLicense = (l: LicenseRow) => {
    setEditLicOriginalCode(l.code);
    setEditLicCode(l.code);
    setEditLicTier(l.tier);
    setEditLicMaxUsers(String(l.max_users));
    setEditLicMaxSessions(l.max_sessions == null ? "" : String(l.max_sessions));
    setEditLicSessionsUsed(String(l.sessions_used));
    setEditLicActiveUsers(String(l.active_users));
    setEditLicBuyer(l.buyer_email ?? "");
    setEditLicActive(l.active);
    setEditLicenseOpen(true);
  };

  const handleSaveLicense = async () => {
    document.body.style.pointerEvents = "";
    const code = editLicCode.trim();
    if (!code) { toast.error("Code required"); return; }
    const maxUsers = parseInt(editLicMaxUsers, 10);
    if (!Number.isFinite(maxUsers) || maxUsers < 1) { toast.error("Max users must be ≥1"); return; }
    const maxSessions = editLicMaxSessions.trim() === "" ? null : parseInt(editLicMaxSessions, 10);
    if (maxSessions !== null && (!Number.isFinite(maxSessions) || maxSessions < 0)) {
      toast.error("Max sessions invalid"); return;
    }
    const sessionsUsed = parseInt(editLicSessionsUsed, 10);
    if (!Number.isFinite(sessionsUsed) || sessionsUsed < 0) { toast.error("Sessions used invalid"); return; }
    const activeUsers = parseInt(editLicActiveUsers, 10);
    if (!Number.isFinite(activeUsers) || activeUsers < 0) { toast.error("Active users invalid"); return; }

    setSavingLicense(true);
    const { error } = await supabase
      .from("licenses")
      .update({
        code,
        tier: editLicTier,
        max_users: maxUsers,
        max_sessions: maxSessions,
        sessions_used: sessionsUsed,
        active_users: activeUsers,
        buyer_email: editLicBuyer.trim() || null,
        active: editLicActive,
      })
      .eq("code", editLicOriginalCode);
    setSavingLicense(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success(`License ${code} updated`);
    setEditLicenseOpen(false);
    fetchLicenses();
  };

  const handleDeleteLicense = async (code: string) => {
    setDeletingLicense(code);
    // Remove any redeemed member rows first (no cascade guaranteed).
    const { error: luErr } = await supabase.from("license_users").delete().eq("license_code", code);
    if (luErr) {
      setDeletingLicense(null);
      toast.error(luErr.message);
      return;
    }
    const { error } = await supabase.from("licenses").delete().eq("code", code);
    setDeletingLicense(null);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success(`License ${code} deleted`);
    fetchLicenses();
  };

  const handleRoleChange = async (userId: string, newRole: AppRole) => {
    if (userId === user?.id) {
      toast.error("You cannot change your own role");
      return;
    }

    setUpdatingRole(userId);

    const { error } = await supabase
      .from("user_roles")
      .update({ role: newRole })
      .eq("user_id", userId);

    if (error) {
      console.error("Error updating role:", error);
      toast.error("Failed to update role");
    } else {
      setUsers((prev) =>
        prev.map((u) => (u.user_id === userId ? { ...u, role: newRole } : u))
      );
      toast.success(`Role updated to ${newRole}`);
    }

    setUpdatingRole(null);
  };

  const handleDeleteUser = async (userId: string, displayName: string | null) => {
    if (userId === user?.id) {
      toast.error("You cannot delete your own account");
      return;
    }

    setDeletingUser(userId);

    const { error } = await supabase.rpc("delete_user_admin", { _user_id: userId });

    if (error) {
      console.error("Error deleting user:", error);
      toast.error("Failed to delete user");
    } else {
      setUsers((prev) => prev.filter((u) => u.user_id !== userId));
      toast.success(`User "${displayName || 'Unknown'}" deleted successfully`);
    }

    setDeletingUser(null);
  };

  const getRoleBadgeVariant = (role: AppRole) => {
    switch (role) {
      case "admin":
        return "destructive";
      case "beta-user":
        return "default";
      case "disabled":
        return "outline";
      default:
        return "secondary";
    }
  };

  const formatJoinedDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleString("en-GB", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "GMT",
      timeZoneName: "short",
    });
  };

  if (loading || checkingAdmin) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>Access Denied</CardTitle>
            <CardDescription>Please sign in to access this page.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => navigate("/auth")}>Sign In</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Shield className="h-5 w-5 text-destructive" />
              Access Denied
            </CardTitle>
            <CardDescription>
              You need administrator privileges to access this page.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" onClick={() => navigate("/")}>
              <ArrowLeft className="h-4 w-4 mr-2" />
              Go Back
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="icon" onClick={() => navigate("/")}>
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <div className="flex items-center gap-2">
              <Shield className="h-6 w-6 text-primary" />
              <h1 className="text-xl font-bold">Admin Panel</h1>
            </div>
          </div>
          <ThemeToggle />
        </div>
      </header>

      <main className="container mx-auto px-4 py-8">
        <Card>
          <CardHeader className="flex flex-row items-start justify-between gap-4">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Users className="h-5 w-5" />
                Registered Users
              </CardTitle>
              <CardDescription>
                Manage user roles and permissions. {users.length} user(s) registered.
              </CardDescription>
            </div>
            <Dialog open={addUserOpen} onOpenChange={setAddUserOpen}>
              <DialogTrigger asChild>
                <Button size="sm"><UserPlus className="h-4 w-4 mr-2" />Add user</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Add registered user</DialogTitle>
                  <DialogDescription>
                    Creates an auth account with a confirmed email. They can sign in immediately.
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-3">
                  <div className="space-y-1">
                    <Label>Email</Label>
                    <Input type="email" value={newUserEmail} onChange={(e) => setNewUserEmail(e.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <Label>Password (≥8 chars)</Label>
                    <Input type="text" value={newUserPassword} onChange={(e) => setNewUserPassword(e.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <Label>Display name (optional)</Label>
                    <Input value={newUserName} onChange={(e) => setNewUserName(e.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <Label>Role</Label>
                    <Select value={newUserRole} onValueChange={(v: AppRole) => setNewUserRole(v)}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent onCloseAutoFocus={(e) => { e.preventDefault(); document.body.style.pointerEvents = ""; }}>
                        <SelectItem value="user">user</SelectItem>
                        <SelectItem value="beta-user">beta-user</SelectItem>
                        <SelectItem value="admin">admin</SelectItem>
                        <SelectItem value="disabled">disabled</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setAddUserOpen(false)}>Cancel</Button>
                  <Button onClick={handleCreateUser} disabled={creatingUser}>
                    {creatingUser ? "Creating…" : "Create user"}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Display Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Joined</TableHead>
                  <TableHead>Current Role</TableHead>
                  <TableHead>Change Role</TableHead>
                  <TableHead className="w-16">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((u) => (
                  <TableRow key={u.user_id}>
                    <TableCell className="font-medium">
                      {u.display_name || "No name"}
                      {u.user_id === user.id && (
                        <span className="ml-2 text-xs text-muted-foreground">(you)</span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {u.email}
                    </TableCell>
                    <TableCell>
                      {formatJoinedDate(u.created_at)}
                    </TableCell>
                    <TableCell>
                      <Badge variant={getRoleBadgeVariant(u.role)}>{u.role}</Badge>
                    </TableCell>
                    <TableCell>
                      {u.user_id === user.id ? (
                        <span className="text-sm text-muted-foreground">—</span>
                      ) : (
                        <Select
                          value={u.role}
                          onValueChange={(value: AppRole) =>
                            handleRoleChange(u.user_id, value)
                          }
                          disabled={updatingRole === u.user_id}
                        >
                          <SelectTrigger className="w-32">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="user">user</SelectItem>
                            <SelectItem value="beta-user">beta-user</SelectItem>
                            <SelectItem value="admin">admin</SelectItem>
                            <SelectItem value="disabled">disabled</SelectItem>
                          </SelectContent>
                        </Select>
                      )}
                    </TableCell>
                    <TableCell>
                      {u.user_id === user.id ? (
                        <span className="text-sm text-muted-foreground">—</span>
                      ) : (
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="text-destructive hover:text-destructive hover:bg-destructive/10"
                              disabled={deletingUser === u.user_id}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>Delete User Account</AlertDialogTitle>
                              <AlertDialogDescription>
                                Are you sure you want to delete the account for "{u.display_name || u.email}"? 
                                This action cannot be undone and will permanently remove their data.
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Cancel</AlertDialogCancel>
                              <AlertDialogAction
                                onClick={() => handleDeleteUser(u.user_id, u.display_name)}
                                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                              >
                                Delete
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
                {users.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-muted-foreground">
                      No users found
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card className="mt-8">
          <CardHeader className="flex flex-row items-start justify-between gap-4">
            <div>
              <CardTitle className="flex items-center gap-2">
                <KeyRound className="h-5 w-5" />
                Licenses
              </CardTitle>
              <CardDescription>
                Paid and free-tier license keys. {licenses.length} license(s).
              </CardDescription>
            </div>
            <Dialog open={addLicenseOpen} onOpenChange={setAddLicenseOpen}>
              <DialogTrigger asChild>
                <Button size="sm"><Plus className="h-4 w-4 mr-2" />Add license</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Add license</DialogTitle>
                  <DialogDescription>
                    Manually issue a license key. Leave max sessions blank for unlimited.
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-3">
                  <div className="space-y-1">
                    <Label>Tier</Label>
                    <Select value={newLicTier} onValueChange={setNewLicTier}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent onCloseAutoFocus={(e) => { e.preventDefault(); document.body.style.pointerEvents = ""; }}>
                        <SelectItem value="free">free</SelectItem>
                        <SelectItem value="test">test (10x try)</SelectItem>
                        <SelectItem value="solo">solo</SelectItem>
                        <SelectItem value="team">team</SelectItem>
                        <SelectItem value="org">org</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label>Code</Label>
                    <div className="flex gap-2">
                      <Input value={newLicCode} onChange={(e) => setNewLicCode(e.target.value)} placeholder="LIC-XXXX-XXXX" />
                      <Button type="button" variant="outline" onClick={generateLicenseCode}>Generate</Button>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <Label>Max users</Label>
                      <Input type="number" min={1} value={newLicMaxUsers} onChange={(e) => setNewLicMaxUsers(e.target.value)} />
                    </div>
                    <div className="space-y-1">
                      <Label>Max sessions</Label>
                      <Input type="number" min={0} value={newLicMaxSessions} onChange={(e) => setNewLicMaxSessions(e.target.value)} placeholder="∞" />
                    </div>
                  </div>
                  <div className="space-y-1">
                    <Label>Buyer email (optional)</Label>
                    <Input type="email" value={newLicBuyer} onChange={(e) => setNewLicBuyer(e.target.value)} />
                  </div>
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setAddLicenseOpen(false)}>Cancel</Button>
                  <Button onClick={handleCreateLicense} disabled={creatingLicense}>
                    {creatingLicense ? "Creating…" : "Create license"}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Code</TableHead>
                  <TableHead>Tier</TableHead>
                  <TableHead>Buyer email</TableHead>
                  <TableHead>Sessions</TableHead>
                  <TableHead>Users</TableHead>
                  <TableHead>Active</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="w-24 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {licenses.map((l) => {
                  const members = licenseUsers.filter((u) => u.license_code === l.code);
                  const isOpen = expandedLicense === l.code;
                  return (
                    <>
                      <TableRow
                        key={l.code}
                        className="cursor-pointer"
                        onClick={() => setExpandedLicense(isOpen ? null : l.code)}
                      >
                        <TableCell className="font-mono text-xs">{l.code}</TableCell>
                        <TableCell>
                          <Badge variant={l.tier === "free" ? "secondary" : "default"}>
                            {l.tier}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {l.buyer_email || "—"}
                        </TableCell>
                        <TableCell>
                          {l.sessions_used}
                          {l.max_sessions != null ? ` / ${l.max_sessions}` : " / ∞"}
                        </TableCell>
                        <TableCell>
                          {l.active_users} / {l.max_users} ({members.length} redeemed)
                        </TableCell>
                        <TableCell>
                          <Badge variant={l.active ? "default" : "outline"}>
                            {l.active ? "yes" : "no"}
                          </Badge>
                        </TableCell>
                        <TableCell>{formatJoinedDate(l.created_at)}</TableCell>
                        <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                          <div className="flex justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => openEditLicense(l)}
                              title="Edit license"
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <AlertDialog>
                              <AlertDialogTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="text-destructive hover:text-destructive hover:bg-destructive/10"
                                  disabled={deletingLicense === l.code}
                                  title="Delete license"
                                >
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              </AlertDialogTrigger>
                              <AlertDialogContent>
                                <AlertDialogHeader>
                                  <AlertDialogTitle>Delete license</AlertDialogTitle>
                                  <AlertDialogDescription>
                                    Permanently delete license <span className="font-mono">{l.code}</span> and all its redeemed user rows? This cannot be undone.
                                  </AlertDialogDescription>
                                </AlertDialogHeader>
                                <AlertDialogFooter>
                                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                                  <AlertDialogAction
                                    onClick={() => handleDeleteLicense(l.code)}
                                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                  >
                                    Delete
                                  </AlertDialogAction>
                                </AlertDialogFooter>
                              </AlertDialogContent>
                            </AlertDialog>
                          </div>
                        </TableCell>
                      </TableRow>
                      {isOpen && (
                        <TableRow key={l.code + "-members"}>
                          <TableCell colSpan={8} className="bg-muted/40">
                            {members.length === 0 ? (
                              <span className="text-sm text-muted-foreground">
                                No users have redeemed this license yet.
                              </span>
                            ) : (
                              <ul className="text-sm space-y-1">
                                {members.map((m) => (
                                  <li key={m.user_email} className="flex justify-between">
                                    <span>{m.user_email}</span>
                                    <span className="text-muted-foreground text-xs">
                                      {formatJoinedDate(m.created_at)}
                                    </span>
                                  </li>
                                ))}
                              </ul>
                            )}
                          </TableCell>
                        </TableRow>
                      )}
                    </>
                  );
                })}
                {licenses.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center text-muted-foreground">
                      No licenses yet
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Dialog open={editLicenseOpen} onOpenChange={setEditLicenseOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Edit license</DialogTitle>
              <DialogDescription>
                Update any field. Leave max sessions blank for unlimited.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div className="space-y-1">
                <Label>Code</Label>
                <Input value={editLicCode} onChange={(e) => setEditLicCode(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label>Tier</Label>
                <Select value={editLicTier} onValueChange={setEditLicTier}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent onCloseAutoFocus={(e) => { e.preventDefault(); document.body.style.pointerEvents = ""; }}>
                    <SelectItem value="free">free</SelectItem>
                    <SelectItem value="test">test (10x try)</SelectItem>
                    <SelectItem value="solo">solo</SelectItem>
                    <SelectItem value="team">team</SelectItem>
                    <SelectItem value="org">org</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label>Max users</Label>
                  <Input type="number" min={1} value={editLicMaxUsers} onChange={(e) => setEditLicMaxUsers(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label>Max sessions</Label>
                  <Input type="number" min={0} value={editLicMaxSessions} onChange={(e) => setEditLicMaxSessions(e.target.value)} placeholder="∞" />
                </div>
                <div className="space-y-1">
                  <Label>Active users (count)</Label>
                  <Input type="number" min={0} value={editLicActiveUsers} onChange={(e) => setEditLicActiveUsers(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label>Sessions used</Label>
                  <Input type="number" min={0} value={editLicSessionsUsed} onChange={(e) => setEditLicSessionsUsed(e.target.value)} />
                </div>
              </div>
              <div className="space-y-1">
                <Label>Buyer email</Label>
                <Input type="email" value={editLicBuyer} onChange={(e) => setEditLicBuyer(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label>Active</Label>
                <Select value={editLicActive ? "yes" : "no"} onValueChange={(v) => setEditLicActive(v === "yes")}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent onCloseAutoFocus={(e) => { e.preventDefault(); document.body.style.pointerEvents = ""; }}>
                    <SelectItem value="yes">yes</SelectItem>
                    <SelectItem value="no">no</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setEditLicenseOpen(false)}>Cancel</Button>
              <Button onClick={handleSaveLicense} disabled={savingLicense}>
                {savingLicense ? "Saving…" : "Save changes"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </main>
    </div>
  );
}
