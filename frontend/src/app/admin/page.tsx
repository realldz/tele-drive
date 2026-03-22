'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/auth-context';
import { Users, Settings, Database, ArrowLeft, Trash2, Edit2, Loader2, HardDrive, ShieldAlert, Menu, X, LogOut, User } from 'lucide-react';
import toast from 'react-hot-toast';
import {
  fetchUsers as fetchUsersApi, fetchSettings as fetchSettingsApi,
  updateSetting, updateUserRole, updateUserQuota, updateUserBandwidth,
  deleteUser as deleteUserApi, fetchUserFiles as fetchUserFilesApi,
  deleteUserFile as deleteUserFileApi,
} from '@/lib/api';

type UserRole = 'ADMIN' | 'USER';

interface User {
  id: string;
  username: string;
  role: UserRole;
  quota: string;
  usedSpace: string;
  dailyBandwidthLimit: string | null;
  dailyBandwidthUsed: string;
  createdAt: string;
}

interface Setting {
  key: string;
  value: string;
}

interface UserFile {
  id: string;
  filename: string;
  size: string;
  mimeType: string;
  createdAt: string;
  isEncrypted: boolean;
}

type Tab = 'USERS' | 'SETTINGS' | 'USER_FILES';

export default function AdminDashboard() {
  const router = useRouter();
  const { user, token, logout } = useAuth();
  const [activeTab, setActiveTab] = useState<Tab>('USERS');
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);
  
  const [users, setUsers] = useState<User[]>([]);
  const [settings, setSettings] = useState<Setting[]>([]);
  const [editingSettings, setEditingSettings] = useState<Record<string, string>>({});
  
  // States for viewing a user's files
  const [selectedUser, setSelectedUser] = useState<User | null>(null);
  const [userFiles, setUserFiles] = useState<UserFile[]>([]);

  // Modals / Edit states
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [editForm, setEditForm] = useState({ quotaGB: 15, bandwidthLimitGB: 0, role: 'USER' });

  useEffect(() => {
    if (!token) {
      router.push('/login');
      return;
    }
    if (user && user.role !== 'ADMIN') {
      toast.error('Không có quyền truy cập');
      router.push('/');
      return;
    }
    if (activeTab === 'USERS') fetchUsers();
    if (activeTab === 'SETTINGS') fetchSettings();
  }, [token, user, activeTab]);

  const fetchUsers = async () => {
    try {
      const data = await fetchUsersApi();
      setUsers(data);
    } catch (err) {
      toast.error('Lỗi lấy danh sách người dùng');
    }
  };

  const fetchSettings = async () => {
    try {
      const data = await fetchSettingsApi();
      setSettings(data);
      const initial: Record<string, string> = {};
      data.forEach((s: Setting) => { initial[s.key] = s.value; });
      setEditingSettings(initial);
    } catch (err) {
      toast.error('Lỗi lấy cấu hình hệ thống');
    }
  };

  const fetchUserFiles = async (userId: string) => {
    try {
      const data = await fetchUserFilesApi(userId);
      setUserFiles(data);
    } catch (err) {
      toast.error('Lỗi lấy danh sách tệp của người dùng');
    }
  };

  const handleUpdateSetting = async (key: string, value: string) => {
    try {
      await updateSetting(key, value);
      toast.success('Đã cập nhật cấu hình');
      fetchSettings();
    } catch (err) {
      toast.error('Lỗi cập nhật cấu hình');
    }
  };

  const formatBytes = (bytes: string | number) => {
    const size = Number(bytes);
    if (size === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(size) / Math.log(k));
    return parseFloat((size / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const handleEditUserSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingUser) return;
    try {
      await updateUserRole(editingUser.id, editForm.role);
      const quotaBytes = editForm.quotaGB * 1024 * 1024 * 1024;
      await updateUserQuota(editingUser.id, quotaBytes.toString());
      const bwBytes = editForm.bandwidthLimitGB > 0 ? (editForm.bandwidthLimitGB * 1024 * 1024 * 1024).toString() : null;
      await updateUserBandwidth(editingUser.id, bwBytes);
      toast.success('Đã cập nhật thông tin người dùng');
      setEditingUser(null);
      fetchUsers();
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'Lỗi cập nhật');
    }
  };

  const handleDeleteUser = async (id: string, username: string) => {
    if (!confirm(`Bạn có chắc muốn xoá vĩnh viễn user "${username}" và TOÀN BỘ dữ liệu của họ? Hành động này không thể hoàn tác!`)) return;
    try {
      await deleteUserApi(id);
      toast.success('Đã xoá người dùng');
      fetchUsers();
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'Lỗi xoá người dùng');
    }
  };

  const handleDeleteUserFile = async (fileId: string) => {
    if (!selectedUser) return;
    if (!confirm('Bạn có chắc muốn xoá vĩnh viễn tệp này của người dùng?')) return;
    try {
      await deleteUserFileApi(selectedUser.id, fileId);
      toast.success('Đã xoá tệp');
      fetchUserFiles(selectedUser.id);
    } catch (err) {
      toast.error('Lỗi xoá tệp');
    }
  };

  if (!user || user.role !== 'ADMIN') return null;

  const handleLogout = () => {
    logout();
    router.push('/login');
  };

  return (
    <div className="h-screen bg-gray-50 flex overflow-hidden">
      
      {/* Mobile Sidebar Overlay */}
      {isMobileSidebarOpen && (
        <div 
          className="fixed inset-0 bg-black/50 z-20 md:hidden"
          onClick={() => setIsMobileSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside className={`fixed md:static inset-y-0 left-0 w-64 bg-slate-900 border-r border-slate-800 flex flex-col transition-transform duration-300 z-30 ${isMobileSidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}`}>
        <div className="p-6 flex items-center justify-between">
          <h1 className="text-2xl font-bold tracking-tight text-white flex items-center gap-2">
            Tele-Drive
          </h1>
          <button className="md:hidden text-slate-400 hover:text-white" onClick={() => setIsMobileSidebarOpen(false)}>
            <X size={24} />
          </button>
        </div>

        <div className="px-6 mb-4">
          <div className="inline-flex items-center gap-2 bg-amber-500/20 text-amber-500 px-3 py-1.5 rounded-lg text-sm font-bold tracking-wide border border-amber-500/30">
            <ShieldAlert size={16} /> ADMIN PANEL
          </div>
        </div>

        <nav className="flex-1 px-4 space-y-2 overflow-y-auto mt-2">
          <button
            onClick={() => { setActiveTab('USERS'); setSelectedUser(null); setIsMobileSidebarOpen(false); }}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg text-left font-medium transition-colors ${activeTab === 'USERS' || activeTab === 'USER_FILES' ? 'bg-blue-600 text-white shadow-sm' : 'text-slate-300 hover:bg-white/5 hover:text-white'}`}
          >
            <Users size={20} />
            Người dùng
          </button>
          <button
            onClick={() => { setActiveTab('SETTINGS'); setIsMobileSidebarOpen(false); }}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg text-left font-medium transition-colors ${activeTab === 'SETTINGS' ? 'bg-blue-600 text-white shadow-sm' : 'text-slate-300 hover:bg-white/5 hover:text-white'}`}
          >
            <Settings size={20} />
            Cấu hình Hệ thống
          </button>
          
          <div className="pt-4 mt-4 border-t border-slate-800"></div>
          <button
            onClick={() => router.push('/')}
            className="w-full flex items-center gap-3 px-4 py-3 rounded-lg text-left font-medium text-slate-300 hover:bg-white/5 hover:text-white transition-colors"
          >
            <ArrowLeft size={20} />
            Về trang chủ Drive
          </button>
        </nav>

        <div className="p-4 border-t border-slate-800">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-slate-800 flex items-center justify-center flex-shrink-0">
              <User size={20} className="text-slate-400" />
            </div>
            <div className="overflow-hidden">
              <p className="font-medium text-white truncate text-sm">{user?.username}</p>
              <button onClick={handleLogout} className="text-xs text-slate-400 hover:text-white transition-colors flex items-center gap-1 mt-1">
                <LogOut size={12} /> Đăng xuất
              </button>
            </div>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col min-w-0 bg-gray-50 relative">
        {/* Topbar for mobile */}
        <header className="md:hidden h-16 border-b border-gray-200 flex items-center px-4 bg-white flex-shrink-0 z-10 w-full">
          <button className="p-2 -ml-2 text-gray-600 hover:bg-gray-100 rounded-lg" onClick={() => setIsMobileSidebarOpen(true)}>
            <Menu size={24} />
          </button>
          <h2 className="text-lg font-bold ml-2 text-gray-800">Admin Panel</h2>
        </header>

        <div className="flex-1 overflow-auto p-4 md:p-6 lg:p-8">
        {activeTab === 'SETTINGS' && (
          <div className="max-w-4xl mx-auto">
            <h2 className="text-2xl font-bold mb-6 text-gray-800">Cấu hình hệ thống (Global Settings)</h2>
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-gray-50 text-gray-600 text-sm">
                    <th className="p-4 font-medium border-b">Key</th>
                    <th className="p-4 font-medium border-b">Value (Bytes)</th>
                    <th className="p-4 font-medium border-b text-right">Hành động</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {settings.map((setting) => (
                    <tr key={setting.key} className="hover:bg-gray-50">
                      <td className="p-4 font-mono text-sm text-gray-800">{setting.key}</td>
                      <td className="p-4">
                        <div className="flex items-center gap-3">
                          <input 
                            type="text" 
                            value={editingSettings[setting.key] ?? setting.value}
                            onChange={(e) => setEditingSettings({ ...editingSettings, [setting.key]: e.target.value })}
                            className="flex-1 w-full border border-gray-300 rounded-lg px-3 py-1.5 focus:ring focus:ring-blue-100 outline-none text-sm"
                          />
                          <span className="text-xs text-gray-400 w-24 text-right flex-shrink-0">
                            {formatBytes(editingSettings[setting.key] ?? setting.value)}
                          </span>
                        </div>
                      </td>
                      <td className="p-4 text-right whitespace-nowrap">
                        <button
                          onClick={() => handleUpdateSetting(setting.key, editingSettings[setting.key] ?? setting.value)}
                          disabled={editingSettings[setting.key] === setting.value}
                          className="px-3 py-1.5 bg-blue-50 text-blue-600 hover:bg-blue-100 disabled:bg-gray-100 disabled:text-gray-400 rounded-md text-sm font-medium transition-colors"
                        >
                          Cập nhật
                        </button>
                      </td>
                    </tr>
                  ))}
                  {settings.length === 0 && (
                    <tr><td colSpan={3} className="p-4 text-center text-gray-500">Đang tải cấu hình...</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {activeTab === 'USERS' && !selectedUser && (
          <div className="max-w-6xl mx-auto">
            <h2 className="text-2xl font-bold mb-6 text-gray-800">Danh sách Người dùng</h2>
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden overflow-x-auto">
              <table className="w-full text-left border-collapse min-w-[800px]">
                <thead>
                  <tr className="bg-gray-50 text-gray-600 text-sm">
                    <th className="p-4 font-medium border-b">Tài khoản</th>
                    <th className="p-4 font-medium border-b">Vai trò</th>
                    <th className="p-4 font-medium border-b">Đã dùng / Dung lượng</th>
                    <th className="p-4 font-medium border-b">Băng thông hôm nay</th>
                    <th className="p-4 font-medium border-b">Ngày tạo</th>
                    <th className="p-4 font-medium border-b text-right">Tuỳ chọn</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {users.map((u) => (
                    <tr key={u.id} className="hover:bg-gray-50">
                      <td className="p-4 font-medium text-gray-800">{u.username}</td>
                      <td className="p-4 text-sm">
                        <span className={`px-2 py-1 rounded-full text-xs font-semibold ${u.role === 'ADMIN' ? 'bg-purple-100 text-purple-700' : 'bg-gray-100 text-gray-700'}`}>
                          {u.role}
                        </span>
                      </td>
                      <td className="p-4 text-sm">
                        <div className="w-full bg-gray-200 rounded-full h-1.5 mb-1">
                          <div className="bg-blue-500 h-1.5 rounded-full" style={{ width: `${Math.min(100, (Number(u.usedSpace) / Number(u.quota)) * 100)}%` }}></div>
                        </div>
                        <span className="text-gray-500 text-xs">{formatBytes(u.usedSpace)} / {formatBytes(u.quota)}</span>
                      </td>
                      <td className="p-4 text-sm text-gray-600">
                        {formatBytes(u.dailyBandwidthUsed)} / {u.dailyBandwidthLimit === null ? 'Không GH' : formatBytes(u.dailyBandwidthLimit)}
                      </td>
                      <td className="p-4 text-sm text-gray-500">{new Date(u.createdAt).toLocaleDateString('vi-VN')}</td>
                      <td className="p-4 text-right space-x-2 whitespace-nowrap">
                        <button 
                          onClick={() => {
                            setSelectedUser(u);
                            setActiveTab('USER_FILES');
                            fetchUserFiles(u.id);
                          }}
                          className="px-3 py-1.5 bg-gray-100 text-gray-700 hover:bg-gray-200 rounded-md text-sm font-medium transition-colors"
                        >
                          Xem tệp
                        </button>
                        <button 
                          onClick={() => {
                            setEditingUser(u);
                            setEditForm({
                              quotaGB: Math.round(Number(u.quota) / (1024 ** 3)),
                              bandwidthLimitGB: u.dailyBandwidthLimit ? Math.round(Number(u.dailyBandwidthLimit) / (1024 ** 3)) : 0,
                              role: u.role
                            });
                          }}
                          className="px-3 py-1.5 bg-blue-50 text-blue-600 hover:bg-blue-100 rounded-md text-sm font-medium transition-colors"
                        >
                          Sửa
                        </button>
                        <button 
                          onClick={() => handleDeleteUser(u.id, u.username)}
                          disabled={user.id === u.id}
                          className="px-3 py-1.5 bg-red-50 text-red-600 hover:bg-red-100 rounded-md text-sm font-medium transition-colors disabled:opacity-50"
                        >
                          Xoá
                        </button>
                      </td>
                    </tr>
                  ))}
                  {users.length === 0 && (
                    <tr><td colSpan={6} className="p-8 text-center text-gray-500">
                      <LoadingSpinner /> Đang tải danh sách người dùng...
                    </td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {activeTab === 'USER_FILES' && selectedUser && (
          <div className="max-w-6xl mx-auto">
            <div className="flex items-center gap-4 mb-6">
              <button 
                onClick={() => { setActiveTab('USERS'); setSelectedUser(null); }}
                className="p-2 bg-gray-200 hover:bg-gray-300 rounded-full transition-colors"
              >
                <ArrowLeft size={20} />
              </button>
              <div>
                <h2 className="text-2xl font-bold text-gray-800">Tệp của {selectedUser.username}</h2>
                <p className="text-gray-500 text-sm">Chỉ hiển thị siêu dữ liệu, quản trị viên không có quyền tải xuống nội dung để đảm bảo quyền riêng tư.</p>
              </div>
            </div>
            
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden overflow-x-auto">
              <table className="w-full text-left border-collapse min-w-[600px]">
                <thead>
                  <tr className="bg-gray-50 text-gray-600 text-sm">
                    <th className="p-4 font-medium border-b">Tên tệp</th>
                    <th className="p-4 font-medium border-b">Kích thước</th>
                    <th className="p-4 font-medium border-b">Định dạng</th>
                    <th className="p-4 font-medium border-b">Ngày tải lên</th>
                    <th className="p-4 font-medium border-b text-right">Tuỳ chọn</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {userFiles.map((file) => (
                    <tr key={file.id} className="hover:bg-gray-50">
                      <td className="p-4 font-medium text-gray-800 flex items-center gap-2">
                        <HardDrive size={18} className="text-blue-500" />
                        <span className="truncate max-w-[200px]">{file.filename}</span>
                        {file.isEncrypted && <span className="bg-green-100 text-green-700 text-[10px] px-1.5 py-0.5 rounded uppercase font-bold">Mã hoá</span>}
                      </td>
                      <td className="p-4 text-sm text-gray-600">{formatBytes(file.size)}</td>
                      <td className="p-4 text-sm text-gray-500">{file.mimeType}</td>
                      <td className="p-4 text-sm text-gray-500">{new Date(file.createdAt).toLocaleString('vi-VN')}</td>
                      <td className="p-4 text-right">
                        <button
                          onClick={() => handleDeleteUserFile(file.id)}
                          className="p-2 text-red-500 hover:bg-red-50 rounded-lg transition-colors inline-block"
                          title="Xoá tệp này vĩnh viễn"
                        >
                          <Trash2 size={18} />
                        </button>
                      </td>
                    </tr>
                  ))}
                  {userFiles.length === 0 && (
                    <tr><td colSpan={5} className="p-8 text-center text-gray-500 italic">Người dùng này không có tệp nào ở thư mục gốc, hoặc đã bị xoá.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
        </div>
      </main>
      
      {/* Edit User Modal */}
      {editingUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md overflow-hidden relative">
            <div className="p-6 border-b border-gray-100">
              <h3 className="text-lg font-bold text-gray-800">Chỉnh sửa User: {editingUser.username}</h3>
              <button className="absolute top-6 right-6 text-gray-400 hover:text-gray-600" onClick={() => setEditingUser(null)}><X size={20}/></button>
            </div>
            <form onSubmit={handleEditUserSubmit} className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Vai trò</label>
                <select 
                  value={editForm.role}
                  onChange={(e) => setEditForm({ ...editForm, role: e.target.value })}
                  disabled={user?.id === editingUser.id}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:ring focus:ring-blue-100 outline-none disabled:bg-gray-100"
                >
                  <option value="USER">Người dùng (USER)</option>
                  <option value="ADMIN">Quản trị viên (ADMIN)</option>
                </select>
                {user?.id === editingUser.id && <p className="text-xs text-orange-500 mt-1">Bạn không thể tự hạ quyền của chính mình</p>}
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Dung lượng tối đa (GB)</label>
                <input 
                  type="number" min="1" step="0.1"
                  value={editForm.quotaGB}
                  onChange={(e) => setEditForm({ ...editForm, quotaGB: parseFloat(e.target.value) })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:ring focus:ring-blue-100 outline-none"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Giới hạn Băng thông tải/ngày (GB)</label>
                <input 
                  type="number" min="0" step="0.1"
                  value={editForm.bandwidthLimitGB}
                  onChange={(e) => setEditForm({ ...editForm, bandwidthLimitGB: parseFloat(e.target.value) })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:ring focus:ring-blue-100 outline-none"
                  placeholder="0 = Không giới hạn"
                />
                <p className="text-xs text-gray-500 mt-1">Cài bằng 0 để bỏ giới hạn</p>
              </div>

              <div className="flex justify-end gap-3 mt-6">
                <button
                  type="button"
                  onClick={() => setEditingUser(null)}
                  className="px-4 py-2 text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg font-medium transition-colors"
                >
                  Huỷ
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 text-white bg-blue-600 hover:bg-blue-700 rounded-lg font-medium transition-colors"
                >
                  Lưu thay đổi
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

function LoadingSpinner() {
  return <Loader2 className="animate-spin text-blue-500 mx-auto" size={24} />;
}
